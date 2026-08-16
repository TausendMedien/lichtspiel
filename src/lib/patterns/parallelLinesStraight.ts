import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";
import { cameraState } from "../globalCameraSettings.svelte";
import { createHeatField, HEAT_WARP_GLSL, pushActive, heatOrPushActive, type HeatField } from "../heatField";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let lineCount = 47;
let scrollSpeed = 0.06;
let lineWidth = 0.19;
let colorSpeed = 0.0;
let rotateSpeed = 0.02;

// Accumulated phases — updated each frame, never reset on hot-reload
let colorPhase = 0;
let rotAngle = 0;
let accTime = 0;

// Heat / Push — the shared field module owns the smoothing, blur and push texture.
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
  uniform vec2 uResolution;
  uniform float uLineCount;
  uniform float uLineWidth;
  uniform float uColorRange;
  uniform float uColorPhase;
  uniform float uRotAngle;

  ${HEAT_WARP_GLSL}

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);

    // Rotate UV around center
    vec2 centered = (vUv - 0.5) * vec2(aspect, 1.0);
    float cosR = cos(uRotAngle);
    float sinR = sin(uRotAngle);
    vec2 uv = vec2(centered.x * cosR - centered.y * sinR,
                   centered.x * sinR + centered.y * cosR);

    // Heat bends the lines around your silhouette; Push clears a path through them.
    if (uHeatStrength > 0.001 || uPushMode > 0.5) {
      vec2 hUv = vec2(1.0 - vUv.x, 1.0 - vUv.y);
      uv += heatWarp(hUv, 0.35, 1.0);
    }

    float scroll = uTime;
    float stripe = fract(uv.x * uLineCount * 0.5 + scroll);

    float fw = fwidth(stripe);
    float line = smoothstep(0.0, fw, stripe) - smoothstep(max(uLineWidth - fw, 0.0), uLineWidth, stripe);

    if (line < 0.01) discard;

    // Smooth cyberpunk hue: sin oscillation between cyan (0.50) and magenta (0.83)
    // Uses sin() instead of fract() → no sudden colour jumps at wrap-around.
    float _sat    = clamp(uColorRange, 0.0, 1.0);
    float _spread = max(0.0, uColorRange - 1.0) / 2.0;
    float hue = 0.665 + sin(uColorPhase + uv.x * _spread * 3.14159) * 0.165;
    float lit = 0.55 + 0.15 * sin(uTime * 0.4 + uv.y * 2.0);
    vec3 col = hsl2rgb(hue, _sat, lit);

    float gray = dot(col, vec3(0.299, 0.587, 0.114));

    float pulse = 0.85 + 0.15 * sin(uTime * 2.0 + stripe * 12.0);
    col *= pulse * line;

    gl_FragColor = vec4(col, line);
  }
`;

export const parallelLinesStraight: Pattern = {
  id: "parallelLinesStraight",
  name: "Parallel Lines",
  heatReactive: true,
  controls: [
    { label: "Line Count",   type: "range", min: 10,  max: 120, step: 1,    default: 47,   tip: "Number of parallel lines.",                              get: () => lineCount,   set: (v) => { lineCount = v; } },
    { label: "Scroll Speed", type: "range", min: 0.02,max: 1.0, step: 0.01, default: 0.06, audioWeight: 0.35, tip: "How fast lines scroll across the screen.",   get: () => scrollSpeed, set: (v) => { scrollSpeed = v; } },
    { label: "Line Width",   type: "range", min: 0.02,max: 0.4, step: 0.01, default: 0.19, tip: "Thickness of each line.",                                get: () => lineWidth,   set: (v) => { lineWidth = v; } },
    { label: "Color Speed",  type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0,    tip: "How fast the palette cycles along the lines.",           get: () => colorSpeed,  set: (v) => { colorSpeed = v; } },
    { label: "Rotate",       type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0.02, audioWeight: 0.3, tip: "Slow rotation of the entire scene.",     get: () => rotateSpeed, set: (v) => { rotateSpeed = v; } },
    { label: "Heat Strength", type: "range", min: 0, max: 2.5, step: 0.1, default: 1.8, interactive: 'heat' as const, tip: "How much heat-map motion bends the lines around the body silhouette. Requires Heat.", get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Blur Radius",   type: "range", min: 0, max: 8,   step: 1,   default: 1,   interactive: 'heat' as const, tip: "Radius of heat-map blur — larger = broader glow around motion zones. Requires Heat.",  get: () => heatBlurR,    set: v => { heatBlurR = v; } },
  ],

  init(ctx: PatternContext) {
    heatField = createHeatField();
    heatWasOn = false;
    vpAspect  = ctx.size.width / Math.max(ctx.size.height, 1);
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uResolution:  { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uLineCount:   { value: lineCount },
        uLineWidth:   { value: lineWidth },
        uColorRange:  { value: colorC2.colorsV2 },
        uColorPhase:  { value: colorPhase },
        uRotAngle:    { value: rotAngle },
        uHeatMap:     { value: heatField.heatTexture },
        uPushField:   { value: heatField.pushTexture },
        uPushMode:    { value: 0 },
        uHeatStrength:{ value: 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, _elapsed: number) {
    if (!material) return;
    accTime    += dt * scrollSpeed;
    colorPhase += dt * colorSpeed * 0.6;
    rotAngle   += dt * rotateSpeed * 1.5;

    if (heatOrPushActive()) {
      heatField?.update(dt, heatBlurR, vpAspect);
      heatWasOn = true;
    } else if (heatWasOn) {
      heatField?.reset();
      heatWasOn = false;
    }

    material.uniforms.uTime.value        = accTime;
    material.uniforms.uLineCount.value   = lineCount;
    material.uniforms.uLineWidth.value   = lineWidth;
    material.uniforms.uColorRange.value  = colorC2.colorsV2;
    material.uniforms.uColorPhase.value  = colorPhase;
    material.uniforms.uRotAngle.value    = rotAngle;
    material.uniforms.uPushMode.value     = pushActive() ? 1 : 0;
    material.uniforms.uHeatStrength.value = cameraState.heatEnabled ? heatStrength : 0;
  },

  resize(width: number, height: number) {
    vpAspect = width / Math.max(height, 1);
    if (material) material.uniforms.uResolution.value.set(width, height);
  },

  dispose() {
    geometry?.dispose(); material?.dispose(); heatField?.dispose();
    mesh = null; geometry = null; material = null;
    heatField = null; heatWasOn = false;
    accTime = 0;
  },
};
