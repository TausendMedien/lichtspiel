import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let columnCount = 70;
let scrollSpeed = 0.0;
let dotSize = 0.60;
let waveAmp = 0.14;
let bubbleCount = 57;
let bubbleSize = 0.050;
let colorRange = 1.0;
let saturation = 1.0;
let colorSpeed = 0.45;
let rotateSpeed = 0.0;

let colorPhase = 0;
let rotAngle = 0;

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
  uniform float uColumnCount;
  uniform float uScrollSpeed;
  uniform float uDotSize;
  uniform float uWaveAmp;
  uniform float uBubbleCount;
  uniform float uBubbleSize;
  uniform float uColorRange;
  uniform float uSaturation;
  uniform float uColorPhase;
  uniform float uRotAngle;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 centered = (vUv - 0.5) * vec2(aspect, 1.0);
    float cosR = cos(uRotAngle);
    float sinR = sin(uRotAngle);
    vec2 uv = vec2(centered.x * cosR - centered.y * sinR,
                   centered.x * sinR + centered.y * cosR);

    // --- Dot curtain ---
    float cols = uColumnCount;
    float cellX = uv.x / aspect * cols;
    float colIdx = floor(cellX + cols * 0.5);
    float waveOffset = sin(colIdx * 0.8 + uTime * 0.5) * uWaveAmp * cols;
    float cellY = uv.y * cols + uTime * uScrollSpeed * cols + waveOffset;
    vec2 cellFrac = fract(vec2(cellX, cellY)) - 0.5;
    float dotDist = length(cellFrac);
    float r = uDotSize * 0.5;
    float dotMask = smoothstep(r, r - 0.02, dotDist);

    float hue = 0.75 + sin(uColorPhase + colIdx / cols * uColorRange * 6.28) * 0.12;
    float lit = 0.55 + 0.1 * sin(uTime * 0.3 + colIdx * 0.3);
    vec3 dotColor = hsl2rgb(hue, 1.0, lit);
    float gray = dot(dotColor, vec3(0.299, 0.587, 0.114));
    dotColor = mix(vec3(gray), dotColor, uSaturation);

    vec3 col = dotColor * dotMask;

    // --- Large floating bubbles ---
    int nBubbles = int(clamp(uBubbleCount, 0.0, 150.0));
    for (int i = 0; i < 150; i++) {
      if (i >= nBubbles) break;
      float fi = float(i);
      float bx = (hash(fi * 3.7) - 0.5) * aspect;
      float by = hash(fi * 11.3) - 0.5;
      float bxA = bx + sin(uTime * 0.12 + fi * 1.9) * 0.03 * aspect;
      float byA = by + sin(uTime * 0.09 + fi * 2.7) * 0.025;
      float bSize = uBubbleSize * (0.5 + hash(fi * 5.1));
      float bDist = length(uv - vec2(bxA, byA));
      float isWhite = step(0.6, hash(fi * 13.7));
      float bHue = 0.78 + hash(fi * 17.3) * 0.04;
      vec3 bColor = mix(hsl2rgb(bHue, 1.0, 0.5), vec3(1.0), isWhite);
      float bGray = dot(bColor, vec3(0.299, 0.587, 0.114));
      bColor = mix(vec3(bGray), bColor, uSaturation);
      // Gaussian glow: no hard edge, smooth at any size
      float nd   = bDist / bSize;
      float core = exp(-nd * nd * 3.0);
      float halo = exp(-nd * nd * 0.5);
      float glow = clamp(core * 0.9 + halo * 0.35, 0.0, 1.0);
      col = mix(col, bColor, glow);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const dotRain: Pattern = {
  id: "dotRain",
  name: "Dot Rain",
  controls: [
    { label: "Column Count",   type: "range", min: 10,   max: 100,  step: 1,     get: () => columnCount, set: (v) => { columnCount = v; } },
    { label: "Scroll Speed",   type: "range", min: 0.0,  max: 1.0,  step: 0.01,  get: () => scrollSpeed, set: (v) => { scrollSpeed = v; } },
    { label: "Dot Size",       type: "range", min: 0.05, max: 0.9,  step: 0.01,  get: () => dotSize,     set: (v) => { dotSize = v; } },
    { label: "Wave Amplitude", type: "range", min: 0.0,  max: 0.5,  step: 0.01,  get: () => waveAmp,     set: (v) => { waveAmp = v; } },
    { label: "Bubble Count",   type: "range", min: 0,    max: 150,  step: 1,     get: () => bubbleCount, set: (v) => { bubbleCount = v; } },
    { label: "Bubble Size",    type: "range", min: 0.01, max: 0.15, step: 0.005, get: () => bubbleSize,  set: (v) => { bubbleSize = v; } },
    { label: "Colors",         type: "range", min: 0.0,  max: 1.0,  step: 0.05,  get: () => colorRange,  set: (v) => { colorRange = v; } },
    { label: "Color Speed",    type: "range", min: 0.0,  max: 1.0,  step: 0.05,  get: () => colorSpeed,  set: (v) => { colorSpeed = v; } },
    { label: "Saturation",     type: "range", min: 0.0,  max: 1.0,  step: 0.05,  get: () => saturation,  set: (v) => { saturation = v; } },
    { label: "Rotate",         type: "range", min: 0.0,  max: 0.5,  step: 0.01,  get: () => rotateSpeed, set: (v) => { rotateSpeed = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uResolution:  { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uColumnCount: { value: columnCount },
        uScrollSpeed: { value: scrollSpeed },
        uDotSize:     { value: dotSize },
        uWaveAmp:     { value: waveAmp },
        uBubbleCount: { value: bubbleCount },
        uBubbleSize:  { value: bubbleSize },
        uColorRange:  { value: colorRange },
        uSaturation:  { value: saturation },
        uColorPhase:  { value: colorPhase },
        uRotAngle:    { value: rotAngle },
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

  update(dt: number, elapsed: number) {
    if (!material) return;
    colorPhase += dt * colorSpeed * 0.6;
    rotAngle   += dt * rotateSpeed * 1.5;
    material.uniforms.uTime.value        = elapsed;
    material.uniforms.uColumnCount.value = columnCount;
    material.uniforms.uScrollSpeed.value = scrollSpeed;
    material.uniforms.uDotSize.value     = dotSize;
    material.uniforms.uWaveAmp.value     = waveAmp;
    material.uniforms.uBubbleCount.value = bubbleCount;
    material.uniforms.uBubbleSize.value  = bubbleSize;
    material.uniforms.uColorRange.value  = colorRange;
    material.uniforms.uSaturation.value  = saturation;
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
  },
};
