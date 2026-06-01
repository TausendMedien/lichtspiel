import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

const COUNT = 50000;

let pointSize = 7.0;
let flowSpeed = 0.2;
let colorRange = 1.0;
let saturation = 0.60;

let points: THREE.Points | null = null;
let geometry: THREE.BufferGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let camera: THREE.PerspectiveCamera | null = null;

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  attribute float aSeed;
  varying float vSeed;

  uniform float uFlowSpeed;

  vec3 flow(vec3 p, float t) {
    float a = sin(p.y * 0.7 + t * 0.4) + cos(p.z * 0.6 - t * 0.3);
    float b = sin(p.z * 0.5 - t * 0.35) + cos(p.x * 0.7 + t * 0.25);
    float c = sin(p.x * 0.6 + t * 0.5) + cos(p.y * 0.5 - t * 0.4);
    return vec3(a, b, c);
  }

  void main() {
    vSeed = aSeed;
    vec3 p = position;
    vec3 disp = flow(p * 0.5 + aSeed, uTime * uFlowSpeed) * 0.6;
    p += disp;
    float ang = uTime * 0.05 * uFlowSpeed + aSeed * 0.0002;
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

    // Cyberpunk hue: cyan (0.50) → blue (0.67) → magenta (0.83), no green
    float hue = 0.5 + fract(vSeed * uColorRange) * 0.33;
    vec3 col = hsl2rgb(hue, 1.0, 0.6);

    // Apply saturation (0 = B&W, 1 = full color)
    float gray = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(gray), col, uSaturation);

    gl_FragColor = vec4(col, alpha);
  }
`;

export const particles: Pattern = {
  id: "particles",
  name: "Particle Field",
  controls: [
    { label: "Point Size",  type: "range", min: 0.3, max: 25.0, step: 0.1, default: 7,  get: () => pointSize,   set: (v) => { pointSize = v; } },
    { label: "Flow Speed",  type: "range", min: 0.1, max: 3.0,  step: 0.1, default: 0.2,  get: () => flowSpeed,   set: (v) => { flowSpeed = v; } },
    { label: "Colors",      type: "range", min: 0.0, max: 1.0,  step: 0.05, default: 1, get: () => colorRange,  set: (v) => { colorRange = v; } },
    { label: "Saturation",  type: "range", min: 0.0, max: 1.0,  step: 0.05, default: 0.6, get: () => saturation,  set: (v) => { saturation = v; } },
  ],

  init(ctx: PatternContext) {
    camera = ctx.camera;
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);

    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const r = Math.cbrt(Math.random()) * 4;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      seeds[i] = Math.random();
    }

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uSize:       { value: pointSize },
        uFlowSpeed:  { value: flowSpeed },
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
  },

  update(_dt: number, elapsed: number) {
    if (!material) return;
    material.uniforms.uTime.value = elapsed;
    material.uniforms.uSize.value = pointSize;
    material.uniforms.uFlowSpeed.value = flowSpeed;
    material.uniforms.uColorRange.value = colorRange;
    material.uniforms.uSaturation.value = saturation;
  },

  resize() {},

  dispose() {
    geometry?.dispose();
    material?.dispose();
    points = null;
    geometry = null;
    material = null;
    camera = null;
  },
};
