import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

// ─── Module state ─────────────────────────────────────────────────────────────
let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let lavaSpeed     = 0.08;
let crackScale    = 3.0;
let glowIntensity = 1.2;
let heatColor     = 0;   // select: Lava / Blue / Plasma
let curvature     = 0.35; // pincushion distortion amount
let rotationSpeed = 0.0;  // UV rotation speed
let flySpeed      = 0.0;  // Z-advance "flying" speed

let accTime   = 0;
let rotAngle  = 0;
let flyOffset = 0;

// ─── Shaders ──────────────────────────────────────────────────────────────────
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2  uResolution;
  uniform float uCrackScale;
  uniform float uGlow;
  uniform int   uHeatColor;
  uniform float uCurvature;
  uniform float uRotAngle;
  uniform float uFlyOffset;

  // ── Noise helpers ──────────────────────────────────────────────────────────
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
    return mix(
      mix(mix(hash(i),             hash(i+vec3(1,0,0)), u.x),
          mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), u.x), u.y),
      mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), u.x),
          mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), u.x), u.y),
      u.z);
  }
  float fbm(vec3 p) {
    float v=0.0, a=0.5;
    for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.1+vec3(1.7,3.1,0.5);a*=0.5;}
    return v;
  }

  // ── 3D Voronoi (crack pattern) ─────────────────────────────────────────────
  float voronoi(vec3 p) {
    vec3 b = floor(p);
    float md = 8.0;
    for(int z=-1;z<=1;z++)
    for(int y=-1;y<=1;y++)
    for(int x=-1;x<=1;x++){
      vec3 nb = b + vec3(x,y,z);
      vec3 pt = nb + hash(nb) - p;
      md = min(md, dot(pt,pt));
    }
    return sqrt(md);
  }

  // ── Color palettes ─────────────────────────────────────────────────────────
  // 4-stop ramp: split 0–0.5 and 0.5–0.75 and 0.75–1.0
  vec3 ramp4(vec3 c0, vec3 c1, vec3 c2, vec3 c3, float v) {
    if (v < 0.5)  return mix(c0, c1, smoothstep(0.0,  0.5,  v));
    if (v < 0.75) return mix(c1, c2, smoothstep(0.5,  0.75, v));
    return              mix(c2, c3, smoothstep(0.75, 1.0,  v));
  }

  vec3 heatPalette(float v) {
    if (uHeatColor == 0) // Lava: black → deep red → orange → bright amber-white
      return ramp4(vec3(0.02,0.0,0.0), vec3(0.80,0.10,0.0), vec3(1.0,0.55,0.0), vec3(1.0,0.95,0.7), v);
    if (uHeatColor == 1) // Blue: black → dark blue → cyan → near-white
      return ramp4(vec3(0.0,0.0,0.04), vec3(0.0,0.20,0.90), vec3(0.1,0.90,1.0), vec3(0.85,0.98,1.0), v);
    // Plasma: dark purple → magenta → cyan-white → bright neon white
    return ramp4(vec3(0.02,0.0,0.05), vec3(0.60,0.0,0.80), vec3(0.50,1.0,1.0), vec3(0.9,1.0,1.0), v);
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 uv = (vUv - 0.5) * vec2(aspect, 1.0);

    // Pincushion distortion: makes the surface appear to curve inward at edges
    float r2 = dot(uv, uv);
    vec2 curved = uv * (1.0 + uCurvature * r2 * 0.5);

    // UV rotation (noise-coordinate rotation → visual rotation)
    float cosR = cos(uRotAngle), sinR = sin(uRotAngle);
    vec2 rotated = vec2(cosR * curved.x - sinR * curved.y,
                        sinR * curved.x + cosR * curved.y);

    // 3D coordinate: (x,y) = rotated surface position, z = fly depth
    vec3 p = vec3(rotated * uCrackScale, uFlyOffset);

    // Voronoi-based crack glow
    float vor   = voronoi(p);
    float crack = 1.0 - smoothstep(0.0, 0.18, vor);
    float flow  = fbm(p * 0.8 + uTime * 0.2);
    float heat  = crack * (0.5 + flow * 0.8);

    // Rock surface base
    float rock = fbm(p * 1.5 - uTime * 0.05);
    float base = rock * 0.25;

    float v   = clamp(base + heat * uGlow, 0.0, 1.0);
    vec3  col = heatPalette(v);

    // Emissive crack glow bypasses the base darkening
    col = mix(col * (0.4 + rock * 0.6),
              heatPalette(clamp(heat * uGlow, 0.0, 1.0)) * uGlow,
              crack * 0.7);

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

// ─── Pattern ──────────────────────────────────────────────────────────────────
export const plasmaSphere: Pattern = {
  id: "plasmaSphere",
  name: "Plasma Surface",
  attribution: "Inspired by Mauricio Massaia — proto-06",
  controls: [
    { label: "Lava Speed",   type: "range", min: 0.0, max: 0.4,  step: 0.01,  default: 0.08, get: () => lavaSpeed,     set: (v) => { lavaSpeed = v; } },
    { label: "Crack Scale",  type: "range", min: 0.5, max: 8.0,  step: 0.1,   default: 3.0,  get: () => crackScale,    set: (v) => { crackScale = v; } },
    { label: "Glow",         type: "range", min: 0.2, max: 3.0,  step: 0.05,  default: 1.2,  get: () => glowIntensity, set: (v) => { glowIntensity = v; } },
    { label: "Heat Color",   type: "select", options: ["Lava", "Blue", "Plasma"],
      get: () => heatColor, set: (v) => { heatColor = v; } },
    { label: "Curvature",    type: "range", min: 0.0, max: 2.0,  step: 0.05,  default: 0.35, get: () => curvature,     set: (v) => { curvature = v; } },
    { label: "Rotation",     type: "range", min: 0.0, max: 0.3,  step: 0.01,  default: 0.0,  get: () => rotationSpeed, set: (v) => { rotationSpeed = v; } },
    { label: "Fly Speed",    type: "range", min: 0.0, max: 2.0,  step: 0.05,  default: 0.0,  get: () => flySpeed,      set: (v) => { flySpeed = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uCrackScale: { value: crackScale },
        uGlow:       { value: glowIntensity },
        uHeatColor:  { value: heatColor },
        uCurvature:  { value: curvature },
        uRotAngle:   { value: 0 },
        uFlyOffset:  { value: 0 },
      },
      vertexShader, fragmentShader,
      depthTest: false, depthWrite: false,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, _elapsed: number) {
    if (!material) return;
    accTime   += dt * lavaSpeed;
    rotAngle  += dt * rotationSpeed * 0.5;
    flyOffset += dt * flySpeed * 0.5;
    material.uniforms.uTime.value       = accTime;
    material.uniforms.uCrackScale.value = crackScale;
    material.uniforms.uGlow.value       = glowIntensity;
    material.uniforms.uHeatColor.value  = heatColor;
    material.uniforms.uCurvature.value  = curvature;
    material.uniforms.uRotAngle.value   = rotAngle;
    material.uniforms.uFlyOffset.value  = flyOffset;
  },

  resize(width: number, height: number) {
    if (material) material.uniforms.uResolution.value.set(width, height);
  },

  dispose() {
    geometry?.dispose(); material?.dispose();
    mesh = null; geometry = null; material = null;
    accTime = 0; rotAngle = 0; flyOffset = 0;
  },
};
