import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let scene: THREE.Scene | null = null;
let speed = 0.02;
let colors = 0.85;
let saturation = 0.95;
let blackPoint = 0.14;

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
  uniform float uSpeed;
  uniform float uColors;
  uniform float uSaturation;
  uniform float uBlackPoint;
  uniform vec2 uResolution;

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

    float t = uTime * uSpeed;
    vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
    vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + t), fbm(p + 4.0 * q + vec2(8.3, 2.8) - t));
    float f = fbm(p + 4.0 * r);

    // Cyberpunk palette: deep indigo → cyan → magenta → electric blue
    vec3 col = mix(
      vec3(0.02, 0.04, 0.25),        // deep indigo
      vec3(0.0,  0.85, 1.0),         // bright cyan
      clamp(f * f * 2.4, 0.0, 1.0)
    );
    col = mix(col, vec3(0.95, 0.05, 0.9) * uColors, clamp(length(q) * 0.6, 0.0, 1.0));
    col = mix(col, vec3(0.1,  0.5,  1.0) * uColors, clamp(r.x * r.y * 1.4, 0.0, 1.0));

    // Saturation (0 = B&W, 1 = full color)
    float gray = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(gray), col, uSaturation);

    // Black point: crush darks, rescale remaining range
    col = clamp((col - uBlackPoint) / max(1.0 - uBlackPoint, 0.001), 0.0, 1.0);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const shaderGradient: Pattern = {
  id: "shaderGradient",
  name: "Shader Gradient",
  controls: [
    { label: "Speed",       type: "range", min: 0.005, max: 0.15, step: 0.005, default: 0.02, get: () => speed,       set: (v) => { speed = v; } },
    { label: "Colors",      type: "range", min: 0.0,   max: 1.0,  step: 0.05, default: 0.85,  get: () => colors,      set: (v) => { colors = v; } },
    { label: "Saturation",  type: "range", min: 0.0,   max: 1.0,  step: 0.05, default: 0.95,  get: () => saturation,  set: (v) => { saturation = v; } },
    { label: "Black Point", type: "range", min: 0.0,   max: 0.8,  step: 0.01, default: 0.14,  get: () => blackPoint,  set: (v) => { blackPoint = v; } },
  ],

  init(ctx: PatternContext) {
    camera = ctx.camera;
    scene = ctx.scene;

    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uSpeed:      { value: speed },
        uColors:      { value: colors },
        uSaturation:  { value: saturation },
        uBlackPoint:  { value: blackPoint },
        uResolution:  { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
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

  update(_dt: number, elapsed: number) {
    if (!material) return;
    material.uniforms.uTime.value = elapsed;
    material.uniforms.uSpeed.value = speed;
    material.uniforms.uColors.value = colors;
    material.uniforms.uSaturation.value = saturation;
    material.uniforms.uBlackPoint.value = blackPoint;
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
    camera = null;
    scene = null;
  },
};
