import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { poseState } from "../pose";

const COUNT = 50000;

let pointSize    = 3.0;
let flowSpeed    = 0.2;
let colorRange   = 1.0;
let colorRange2  = 1.0;
let attractStrength = 0.4;
let bodyTracking = true;

let points: THREE.Points | null = null;
let geometry: THREE.BufferGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let accTime = 0;
let currentAspect = 1;

// Pre-allocated attractor pool
const attractors = Array.from({ length: 15 }, () => new THREE.Vector3());

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  uniform vec3  uAttractors[15];
  uniform int   uAttractorCount;
  uniform float uAttractStrength;
  attribute float aSeed;
  varying float vSeed;

  vec3 flow(vec3 p, float t) {
    float a = sin(p.y * 0.7 + t * 0.4) + cos(p.z * 0.6 - t * 0.3);
    float b = sin(p.z * 0.5 - t * 0.35) + cos(p.x * 0.7 + t * 0.25);
    float c = sin(p.x * 0.6 + t * 0.5) + cos(p.y * 0.5 - t * 0.4);
    return vec3(a, b, c);
  }

  void main() {
    vSeed = aSeed;
    vec3 p = position;
    vec3 disp = flow(p * 0.5 + aSeed, uTime) * 0.6;
    p += disp;
    float ang = uTime * 0.05 + aSeed * 0.0002;
    float cs = cos(ang), sn = sin(ang);
    p.xz = mat2(cs, -sn, sn, cs) * p.xz;

    // Attract toward body points
    for (int i = 0; i < 15; i++) {
      if (i >= uAttractorCount) break;
      vec3 diff = uAttractors[i] - p;
      float dist = length(diff) + 0.001;
      float pull = uAttractStrength / (0.3 + dist * dist * 0.4);
      p += normalize(diff) * pull;
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (8.0 / -mv.z);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uColorRange;
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

export const particlesBody: Pattern = {
  id: "particlesBody",
  usesPose: true,
  name: "Particle Field",
  controls: [
    { label: "Point Size",       type: "range", min: 1.0, max: 6.0,  step: 0.1,  default: 3,   get: () => pointSize,       set: (v) => { pointSize = v; } },
    { label: "Flow Speed",       type: "range", min: 0.0, max: 3.0,  step: 0.1,  default: 0.2, get: () => flowSpeed,       set: (v) => { flowSpeed = v; } },
    { label: "Attract Strength", type: "range", min: 0.0, max: 2.0,  step: 0.05, default: 0.4, interactive: 'pose' as const, get: () => attractStrength, set: (v) => { attractStrength = v; } },
    { label: "Colors",           type: "range", min: 0.0, max: 1.0,  step: 0.05, default: 1,   get: () => colorRange,      set: (v) => { colorRange = v; } },
    { label: "Colors v2",        type: "range", min: 0.0, max: 3.0,  step: 0.05, default: 1,   get: () => colorRange2,     set: (v) => { colorRange2 = v; } },
  ],

  init(ctx: PatternContext) {
    camera = ctx.camera;
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);
    currentAspect = ctx.size.width / Math.max(ctx.size.height, 1);

    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const r = Math.cbrt(Math.random()) * 4;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      seeds[i] = Math.random();
    }

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:            { value: 0 },
        uSize:            { value: pointSize },
        uColorRange:      { value: colorRange },
        uColorRange2:     { value: colorRange2 },
        uAttractors:      { value: attractors },
        uAttractorCount:  { value: 0 },
        uAttractStrength: { value: attractStrength },
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

    // Map pose landmarks to 3D world space
    // Camera at z=4, FOV=75°: half-height at z=0 ≈ 3.07
    let count = 0;
    if (bodyTracking) {
      const scaleY = 6.0;
      const scaleX = scaleY * currentAspect;
      outer: for (const person of poseState.persons) {
        for (const pt of person) {
          if (count >= 15) break outer;
          attractors[count].set(
            (pt.x - 0.5) * scaleX,
            (0.5 - pt.y) * scaleY,
            0,
          );
          count++;
        }
      }
    }

    material.uniforms.uTime.value             = accTime;
    material.uniforms.uSize.value             = pointSize;
    material.uniforms.uColorRange.value       = colorRange;
    material.uniforms.uColorRange2.value      = colorRange2;
    material.uniforms.uAttractorCount.value   = count;
    material.uniforms.uAttractStrength.value  = attractStrength;
  },

  resize(_w: number, _h: number) {
    currentAspect = _w / Math.max(_h, 1);
  },

  dispose() {
    geometry?.dispose();
    material?.dispose();
    points = null;
    geometry = null;
    material = null;
    camera = null;
    accTime = 0;
  },
};
