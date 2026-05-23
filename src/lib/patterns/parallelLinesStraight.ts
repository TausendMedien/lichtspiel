import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";

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
  controls: [
    { label: "Line Count",   type: "range", min: 10,  max: 120, step: 1, default: 47,    get: () => lineCount,   set: (v) => { lineCount = v; } },
    { label: "Scroll Speed", type: "range", min: 0.02,max: 1.0, step: 0.01, default: 0.06, audioWeight: 0.35, get: () => scrollSpeed, set: (v) => { scrollSpeed = v; } },
    { label: "Line Width",   type: "range", min: 0.02,max: 0.4, step: 0.01, default: 0.19, get: () => lineWidth,   set: (v) => { lineWidth = v; } },
    { label: "Color Speed",  type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0, get: () => colorSpeed,  set: (v) => { colorSpeed = v; } },
    { label: "Rotate",       type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0.02, audioWeight: 0.3, get: () => rotateSpeed, set: (v) => { rotateSpeed = v; } },
  ],

  init(ctx: PatternContext) {
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
    material.uniforms.uTime.value        = accTime;
    material.uniforms.uLineCount.value   = lineCount;
    material.uniforms.uLineWidth.value   = lineWidth;
    material.uniforms.uColorRange.value  = colorC2.colorsV2;
    material.uniforms.uColorPhase.value  = colorPhase;
    material.uniforms.uRotAngle.value    = rotAngle;
  },

  resize(width: number, height: number) {
    if (material) material.uniforms.uResolution.value.set(width, height);
  },

  dispose() {
    geometry?.dispose();
    material?.dispose();
    mesh = null;
    geometry = null;
    material = null;
    accTime = 0;
  },
};
