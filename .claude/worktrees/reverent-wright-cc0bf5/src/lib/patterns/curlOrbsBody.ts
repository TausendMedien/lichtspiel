import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { poseState } from "../pose";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let lineCount   = 45;
let lineWidth   = 0.37;
let flowScale   = 3.1;
let flowSpeed   = 0.02;
let orbCount    = 16;
let orbSize     = 0.060;
let colorRange  = 0.40;
let saturation  = 1.0;
let colorSpeed  = 0.05;
let brightness  = 0.80;
let rotateSpeed = 0.0;
let bodyTracking = true;

let colorPhase = 0;
let rotAngle   = 0;
let accTime    = 0;
let currentAspect = 1;

// Pre-allocated pool for person-point uniforms (up to 15 points: 5 persons × 3 points each)
const personPoints = Array.from({ length: 15 }, () => new THREE.Vector2());

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2  uResolution;
  uniform float uLineCount;
  uniform float uLineWidth;
  uniform float uFlowScale;
  uniform float uOrbCount;
  uniform float uOrbSize;
  uniform float uColorRange;
  uniform float uSaturation;
  uniform float uColorPhase;
  uniform float uBrightness;
  uniform float uRotAngle;
  uniform vec2  uPersonPoints[15];
  uniform int   uPersonCount;

  float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
  float hash(vec2 p)   { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) { v += a*noise(p); p = p*2.1+vec2(3.1,1.7); a *= 0.5; }
    return v;
  }
  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h*6.0+vec3(0,4,2),6.0)-3.0)-1.0, 0.0, 1.0);
    return l + s*(rgb-0.5)*(1.0-abs(2.0*l-1.0));
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 c = (vUv - 0.5) * vec2(aspect, 1.0);
    float cosR = cos(uRotAngle), sinR = sin(uRotAngle);
    vec2 p = vec2(c.x*cosR - c.y*sinR, c.x*sinR + c.y*cosR);
    float t = uTime;

    // Hash-based orbs: deflect evalP
    vec2 evalP = p;
    int nOrbs = int(clamp(uOrbCount, 0.0, 20.0));
    for (int i = 0; i < 20; i++) {
      if (i >= nOrbs) break;
      float fi  = float(i);
      float bx  = (hash1(fi * 3.7)  - 0.5) * aspect;
      float by  = hash1(fi * 11.3) - 0.5;
      float bxA = bx + sin(uTime * 0.07 + fi * 2.1) * 0.015 * aspect;
      float byA = by + sin(uTime * 0.05 + fi * 3.3) * 0.012;
      float bSz = uOrbSize * (0.35 + hash1(fi * 5.1));
      vec2  d   = p - vec2(bxA, byA);
      float r   = length(d);
      float influence = bSz * bSz / max(r * r, bSz * bSz * 0.12);
      float fade      = smoothstep(bSz * 5.0, bSz * 1.1, r);
      evalP += normalize(d) * bSz * influence * fade * 0.65;
    }

    // Person-point deflection (stronger, larger radius than hash orbs)
    float personOrbSize = uOrbSize * 2.2;
    for (int i = 0; i < 15; i++) {
      if (i >= uPersonCount) break;
      vec2  d   = p - uPersonPoints[i];
      float r   = length(d);
      float influence = personOrbSize * personOrbSize / max(r * r, personOrbSize * personOrbSize * 0.12);
      float fade      = smoothstep(personOrbSize * 5.0, personOrbSize * 1.1, r);
      evalP += normalize(d) * personOrbSize * influence * fade * 0.65;
    }

    // Flow field with deflected coordinates
    vec2 q    = vec2(fbm(evalP * uFlowScale + t),
                     fbm(evalP * uFlowScale + vec2(5.2, 1.3) - t * 0.8));
    float phi = fbm(evalP * uFlowScale * 0.65 + 2.8 * q);

    float band = fract(phi * uLineCount);
    float aa   = max(fwidth(band), 0.004);
    float lw   = clamp(uLineWidth * 0.5, aa * 2.0, 0.48);
    float line = smoothstep(0.0, aa, band) * smoothstep(lw, lw - aa, band);

    float hue    = 0.5 + sin(uColorPhase + phi * uColorRange * 6.28) * 0.08;
    vec3 lineCol = mix(hsl2rgb(hue, uSaturation, 0.65), vec3(1.0), 0.45);
    vec3 bgCol   = mix(vec3(0.0, 0.025, 0.04), vec3(0.0, 0.07, 0.11), phi * 0.6 + 0.2);
    vec3 col     = bgCol + lineCol * line * uBrightness;

    // Hash-based orb glows (blue-white)
    for (int i = 0; i < 20; i++) {
      if (i >= nOrbs) break;
      float fi  = float(i);
      float bx  = (hash1(fi * 3.7)  - 0.5) * aspect;
      float by  = hash1(fi * 11.3) - 0.5;
      float bxA = bx + sin(uTime * 0.07 + fi * 2.1) * 0.015 * aspect;
      float byA = by + sin(uTime * 0.05 + fi * 3.3) * 0.012;
      float bSz = uOrbSize * (0.35 + hash1(fi * 5.1));
      float bd  = length(p - vec2(bxA, byA));
      float nd  = bd / bSz;
      float core = exp(-nd * nd * 2.8);
      float halo = exp(-nd * nd * 0.35);
      col += vec3(0.85, 0.93, 1.0) * (core + halo * 0.28) * uBrightness;
    }

    // Person-point glows (warm magenta/purple tint — visually distinct)
    for (int i = 0; i < 15; i++) {
      if (i >= uPersonCount) break;
      float bd = length(p - uPersonPoints[i]);
      float nd = bd / personOrbSize;
      float core = exp(-nd * nd * 2.0);
      float halo = exp(-nd * nd * 0.25);
      col += vec3(0.95, 0.6, 1.0) * (core * 0.9 + halo * 0.3) * uBrightness;
    }

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export const curlOrbsBody: Pattern = {
  id: "curlOrbsBody",
  usesPose: true,
  name: "Curl Orbs Body",
  controls: [
    { label: "Body Tracking", type: "toggle", get: () => bodyTracking, set: (v) => { bodyTracking = v; } },
    { label: "Line Count",   type: "range", min: 10,   max: 100,  step: 1, default: 45,    get: () => lineCount,   set: (v) => { lineCount = v; } },
    { label: "Line Width",   type: "range", min: 0.05, max: 0.9,  step: 0.01, default: 0.37, get: () => lineWidth,  set: (v) => { lineWidth = v; } },
    { label: "Flow Scale",   type: "range", min: 0.5,  max: 5.0,  step: 0.1, default: 3.1,  get: () => flowScale,  set: (v) => { flowScale = v; } },
    { label: "Flow Speed",   type: "range", min: 0.0,  max: 0.3,  step: 0.005, default: 0.02, get: () => flowSpeed, set: (v) => { flowSpeed = v; } },
    { label: "Orb Count",    type: "range", min: 0,    max: 20,   step: 1, default: 16,    get: () => orbCount,   set: (v) => { orbCount = v; } },
    { label: "Orb Size",     type: "range", min: 0.01, max: 0.15, step: 0.005, default: 0.06, get: () => orbSize,  set: (v) => { orbSize = v; } },
    { label: "Colors",       type: "range", min: 0.0,  max: 1.0,  step: 0.05, default: 0.4,  get: () => colorRange, set: (v) => { colorRange = v; } },
    { label: "Color Speed",  type: "range", min: 0.0,  max: 1.0,  step: 0.05, default: 0.05, get: () => colorSpeed, set: (v) => { colorSpeed = v; } },
    { label: "Saturation",   type: "range", min: 0.0,  max: 1.0,  step: 0.05, default: 1,    get: () => saturation, set: (v) => { saturation = v; } },
    { label: "Brightness",   type: "range", min: 0.2,  max: 2.0,  step: 0.05, default: 0.8,  get: () => brightness, set: (v) => { brightness = v; } },
    { label: "Rotate",       type: "range", min: 0.0,  max: 0.5,  step: 0.01, default: 0,    get: () => rotateSpeed, set: (v) => { rotateSpeed = v; } },
  ],

  init(ctx: PatternContext) {
    currentAspect = ctx.size.width / Math.max(ctx.size.height, 1);
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:         { value: 0 },
        uResolution:   { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uLineCount:    { value: lineCount },
        uLineWidth:    { value: lineWidth },
        uFlowScale:    { value: flowScale },
        uOrbCount:     { value: orbCount },
        uOrbSize:      { value: orbSize },
        uColorRange:   { value: colorRange },
        uSaturation:   { value: saturation },
        uColorPhase:   { value: colorPhase },
        uBrightness:   { value: brightness },
        uRotAngle:     { value: rotAngle },
        uPersonPoints: { value: personPoints },
        uPersonCount:  { value: 0 },
      },
      vertexShader, fragmentShader, depthTest: false, depthWrite: false,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, _elapsed: number) {
    if (!material) return;
    accTime    += dt * flowSpeed;
    colorPhase += dt * colorSpeed * 0.5;
    rotAngle   += dt * rotateSpeed * 1.5;

    // Convert pose landmarks to shader coordinate space
    let count = 0;
    if (bodyTracking) {
      const cosR = Math.cos(rotAngle);
      const sinR = Math.sin(rotAngle);
      outer: for (const person of poseState.persons) {
        for (const pt of person) {
          if (count >= 15) break outer;
          const sx = (pt.x - 0.5) * currentAspect;
          const sy = 0.5 - pt.y;
          personPoints[count].set(sx * cosR - sy * sinR, sx * sinR + sy * cosR);
          count++;
        }
      }
    }

    material.uniforms.uTime.value       = accTime;
    material.uniforms.uLineCount.value  = lineCount;
    material.uniforms.uLineWidth.value  = lineWidth;
    material.uniforms.uFlowScale.value  = flowScale;
    material.uniforms.uOrbCount.value   = orbCount;
    material.uniforms.uOrbSize.value    = orbSize;
    material.uniforms.uColorRange.value = colorRange;
    material.uniforms.uSaturation.value = saturation;
    material.uniforms.uColorPhase.value = colorPhase;
    material.uniforms.uBrightness.value = brightness;
    material.uniforms.uRotAngle.value   = rotAngle;
    material.uniforms.uPersonCount.value = count;
  },

  resize(width: number, height: number) {
    currentAspect = width / Math.max(height, 1);
    if (material) material.uniforms.uResolution.value.set(width, height);
  },

  dispose() {
    geometry?.dispose(); material?.dispose();
    mesh = null; geometry = null; material = null;
    accTime = 0; rotAngle = 0; colorPhase = 0;
  },
};
