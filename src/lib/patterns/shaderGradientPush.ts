import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";
import { cameraState } from "../globalCameraSettings.svelte";
import { createHeatField, HEAT_WARP_GLSL, pushActive, heatOrPushActive, type HeatField } from "../heatField";

// Shader Gradient — Push: same fbm plasma as Shader Gradient, but Push does not
// move the sample position at all — it reads the SIZE of the push field instead.
// The push field is an eviction offset: large deep inside a sweep, falling to
// exactly zero just past its edge. That size (not the raw vector, whose discrete
// distance-transform direction is blocky at the pixel scale) drives two things:
// deep inside erases toward the dark base, and the ring where that size falls
// fastest — the swept area's edge — gets boosted, as if the erased brightness
// had piled up right there. The result reads as displacement, not a dimmer
// switch: sweep a hand through it and the bright plasma visibly flees to a ring
// around where you swept, leaving the middle dark, then the ring settles back in
// as the push field relaxes (Return Speed) and re-covers (Softness), same as
// every other Push pattern.
//
// Heat (Attract) is untouched from the original: it still bends the sample
// position, so the two sensors read as genuinely different tools on the same
// pattern, not the same trick twice.

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let scene: THREE.Scene | null = null;
let speed = 0.02;
let accTime = 0;
let colors = 0.85;
let dynamic = 0.6;
let eraseAmount = 34.0;

let heatStrength  = 1.8;
let heatBlurR     = 1;
let heatField: HeatField | null = null;
let heatWasOn = false;
let vpAspect = 1;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uColors;
  uniform float uDynamic;
  uniform float uEraseAmount;
  uniform vec2 uResolution;
  uniform float uColorsV2;
  uniform vec3  uMainColor;

  ${HEAT_WARP_GLSL}

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.0;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.0;
    vec2 hUv = vec2(1.0 - vUv.x, 1.0 - vUv.y);

    // Heat still bends the plasma's sample position, same as the original —
    // Push does not touch position at all, only what happens after, below.
    if (uPushMode < 0.5 && uHeatStrength > 0.001) {
      p += heatWarp(hUv, 1.2, 2.0);
    }

    float t = uTime;
    vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
    vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + t), fbm(p + 4.0 * q + vec2(8.3, 2.8) - t));
    float f = fbm(p + 4.0 * r);

    // Cyberpunk palette: deep indigo → cyan → magenta → electric blue
    vec3 dark = vec3(0.02, 0.04, 0.25);
    vec3 col = mix(
      dark,
      vec3(0.0,  0.85, 1.0),         // bright cyan
      clamp(f * f * 2.4, 0.0, 1.0)
    );
    col = mix(col, vec3(0.95, 0.05, 0.9) * uColors, clamp(length(q) * 0.6, 0.0, 1.0));
    col = mix(col, vec3(0.1,  0.5,  1.0) * uColors, clamp(r.x * r.y * 1.4, 0.0, 1.0));

    // Dynamic: contrast around mid-gray (0 = flat/uniform, 1 = full contrast)
    float contrast = 0.2 + uDynamic * 1.8;
    col = (col - 0.5) * contrast + 0.5;
    col = clamp(col, 0.0, 1.0);

    // Push reads the SIZE of the eviction offset at this pixel (large deep inside
    // a sweep, falling to exactly zero just past its edge) rather than its raw
    // vector — the offset field's discrete distance-transform directions are
    // blocky at the pixel scale, but its magnitude is smooth, so working from
    // magnitude alone (and an edge-detector on that magnitude for the rim) stays
    // clean instead of picking up per-pixel direction noise.
    //
    // Deep inside (high magnitude) erases toward the dark base; the ring where
    // that magnitude falls fastest — the boundary of the swept area — is boosted,
    // as if the erased brightness had piled up right there. Erase and pile are
    // driven by different features of the same field (level vs. edge) so they
    // never both fire on the same pixel: the result reads as PUSHED, not merely
    // darkened in place.
    if (uPushMode > 0.5) {
      vec2 peps = vec2(1.5 / 160.0, 1.5 / 90.0);
      float mC = length(texture2D(uPushField, clamp(hUv, 0.0, 1.0)).rg);
      float mL = length(texture2D(uPushField, clamp(hUv - vec2(peps.x, 0.0), 0.0, 1.0)).rg);
      float mR = length(texture2D(uPushField, clamp(hUv + vec2(peps.x, 0.0), 0.0, 1.0)).rg);
      float mD = length(texture2D(uPushField, clamp(hUv - vec2(0.0, peps.y), 0.0, 1.0)).rg);
      float mU = length(texture2D(uPushField, clamp(hUv + vec2(0.0, peps.y), 0.0, 1.0)).rg);
      float rimEdge = length(vec2(mR - mL, mU - mD));

      float luma  = dot(col, vec3(0.299, 0.587, 0.114));
      float erase = clamp(mC * uEraseAmount, 0.0, 1.0) * smoothstep(0.08, 0.55, luma);
      float pile  = clamp(rimEdge * uEraseAmount * 6.0, 0.0, 1.0);

      col = mix(col, dark, erase);
      col = mix(col, clamp((col - dark) * 1.7 + dark, 0.0, 1.0), pile);
    }

    vec3 _orig = col;
    float _luma = dot(_orig, vec3(0.299, 0.587, 0.114));
    float _ph1 = clamp(uColorsV2, 0.0, 1.0);
    float _ph2 = clamp((uColorsV2 - 1.0) / 2.0, 0.0, 1.0);
    col = mix(mix(vec3(_luma), uMainColor * (0.2 + _luma * 0.8), _ph1), _orig, _ph2);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export const shaderGradientPush: Pattern = {
  id: "shaderGradientPush",
  name: "Shader Gradient — Push",
  heatReactive: true,
  controls: [
    { label: "Speed",         type: "range", min: 0.005, max: 0.15, step: 0.005, default: 0.02, tip: "How fast the gradient flows and shifts across the screen.", get: () => speed,   set: (v) => { speed = v; } },
    { label: "Dynamic",       type: "range", min: 0.0,   max: 1.0,  step: 0.05,  default: 0.6,  tip: "Amount of noise turbulence added to the gradient. 0 = smooth, 1 = fully animated.", get: () => dynamic, set: (v) => { dynamic = v; } },
    { label: "Erase Amount",  type: "range", min: 0.0,   max: 80.0, step: 2.0,   default: 34.0, tip: "How strongly Push carves a gap and piles brightness at its rim. Higher = a smaller sweep clears more.", get: () => eraseAmount, set: (v) => { eraseAmount = v; } },
    { label: "Heat Strength", type: "range", min: 0, max: 2.5, step: 0.1, default: 1.8, interactive: 'heat' as const, tip: "How much heat-map motion bends the gradient around the body. Requires Heat — Push instead carves a gap, see Erase Amount.", get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Blur Radius",   type: "range", min: 0, max: 8, step: 1,   default: 1,   interactive: 'heat' as const, tip: "Radius of heat-map blur — larger = broader glow around motion zones. Affects Heat and Push alike.",  get: () => heatBlurR,    set: v => { heatBlurR = v; } },
  ],

  init(ctx: PatternContext) {
    camera = ctx.camera;
    scene = ctx.scene;

    heatField = createHeatField();
    heatWasOn = false;
    vpAspect  = ctx.size.width / Math.max(ctx.size.height, 1);

    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uColors:      { value: colors },
        uDynamic:     { value: dynamic },
        uEraseAmount: { value: eraseAmount },
        uResolution:  { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uColorsV2:    { value: colorC2.colorsV2 },
        uMainColor:   { value: new THREE.Vector3() },
        uHeatMap:     { value: heatField.heatTexture },
        uPushField:   { value: heatField.pushTexture },
        uPushMode:    { value: 0 },
        uHeatStrength:{ value: 0 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, _elapsed: number) {
    if (!material) return;
    accTime += dt * speed;

    if (heatOrPushActive()) {
      heatField?.update(dt, heatBlurR, vpAspect);
      heatWasOn = true;
    } else if (heatWasOn) {
      heatField?.reset();
      heatWasOn = false;
    }

    material.uniforms.uTime.value         = accTime;
    material.uniforms.uColors.value       = colors;
    material.uniforms.uDynamic.value      = dynamic;
    material.uniforms.uEraseAmount.value  = eraseAmount;
    material.uniforms.uPushMode.value     = pushActive() ? 1 : 0;
    material.uniforms.uHeatStrength.value = cameraState.heatEnabled ? heatStrength : 0;
    const _mc = new THREE.Color(colorC2.main);
    material.uniforms.uMainColor.value.set(_mc.r, _mc.g, _mc.b);
    material.uniforms.uColorsV2.value = colorC2.colorsV2;
  },

  resize(width: number, height: number) {
    if (material) material.uniforms.uResolution.value.set(width, height);
  },

  dispose() {
    geometry?.dispose();
    material?.dispose();
    heatField?.dispose();
    mesh = null;
    geometry = null;
    material = null;
    camera = null;
    scene = null;
    heatField = null; heatWasOn = false;
    accTime = 0;
  },
};
