import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let dotDensity  = 35;
let dotSize     = 0.67;
let warpAmount  = 3.0;
let flowSpeed   = 0.01;
let swirlLines  = 1.25;
let saturation  = 0.95;
let colorSpeed  = 0.35;
let brightness  = 1.45;
let rotateSpeed = 0.01;

let colorPhase = 0;
let rotAngle   = 0;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2  uResolution;
  uniform float uDotDensity;
  uniform float uDotSize;
  uniform float uWarpAmount;
  uniform float uFlowSpeed;
  uniform float uSwirlLines;
  uniform float uSaturation;
  uniform float uColorPhase;
  uniform float uBrightness;
  uniform float uRotAngle;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a*noise(p); p = p*2.1+vec2(3.1,1.7); a *= 0.5; }
    return v;
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 c = (vUv - 0.5) * vec2(aspect, 1.0);
    float cosR = cos(uRotAngle), sinR = sin(uRotAngle);
    vec2 p = vec2(c.x*cosR - c.y*sinR, c.x*sinR + c.y*cosR);
    float t = uTime * uFlowSpeed;

    // Baroque-style three-level domain warp
    vec2 q = vec2(fbm(p * 1.3 + t),
                  fbm(p * 1.3 + vec2(5.2, 1.3) - t * 0.8));
    vec2 r = vec2(fbm(p * 0.9 + uWarpAmount * q + vec2(1.7, 9.2) + t * 0.5),
                  fbm(p * 0.9 + uWarpAmount * q + vec2(8.3, 2.8) - t * 0.3));
    float phi = fbm(p * 0.7 + uWarpAmount * r);

    // Organic purple background — the whole image is the flow field
    vec3 bgCol = mix(vec3(0.04, 0.0, 0.10), vec3(0.22, 0.02, 0.46), phi);
    bgCol      = mix(bgCol, vec3(0.40, 0.08, 0.75), q.x * 0.38);

    // Decorative swirl lines as part of the background texture
    float sPhi  = fbm(p * 2.6 + q + t * 0.4 + vec2(uColorPhase * 0.3, 0.0));
    float sBand = fract(sPhi * 26.0);
    float sAA   = max(fwidth(sBand), 0.007);
    float sLine = smoothstep(0.0, sAA, sBand) * smoothstep(0.08, 0.05 - sAA, sBand);
    bgCol += vec3(0.7, 0.44, 1.0) * sLine * uSwirlLines;

    // Dot grid warped by the flow — dots follow organic curves
    vec2 warpedP = p + (q - 0.5) * uWarpAmount * 0.28;
    vec2 cf = fract(warpedP * uDotDensity) - 0.5;
    float dd = length(cf);

    // Dot radius driven by the flow field value (large in crests, small in troughs)
    float rDot = uDotSize * (0.18 + 0.82 * phi) * 0.44;
    float aa   = max(fwidth(dd), 0.003);
    float dotMask = smoothstep(rDot + aa, rDot - aa, dd);

    // 3D sphere shading
    vec2  ln  = cf / max(rDot, 0.001);
    float nz  = sqrt(max(0.0, 1.0 - dot(ln, ln)));
    vec3  sN  = normalize(vec3(ln, nz));
    vec3  ld  = normalize(vec3(-0.5, 0.7, 0.8));
    float df  = max(0.0, dot(sN, ld));
    float sp  = pow(max(0.0, dot(reflect(-ld, sN), vec3(0,0,1))), 28.0);
    vec3  pBase = mix(vec3(0.44, 0.07, 0.88), vec3(0.88, 0.72, 1.0), phi * uSaturation);
    float gray  = dot(pBase, vec3(0.299, 0.587, 0.114));
    pBase = mix(vec3(gray), pBase, uSaturation);
    vec3  pCol = pBase * (0.25 + 0.75 * df) + vec3(1.0) * sp * 0.85;

    vec3 col = mix(bgCol, pCol * uBrightness, dotMask);
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export const pearlFlow: Pattern = {
  id: "pearlFlow",
  name: "Pearl Flow",
  controls: [
    { label: "Dot Density",  type: "range", min: 5,   max: 40,  step: 1, default: 35,    get: () => dotDensity,  set: (v) => { dotDensity = v; } },
    { label: "Dot Size",     type: "range", min: 0.1, max: 1.0, step: 0.01, default: 0.67, get: () => dotSize,     set: (v) => { dotSize = v; } },
    { label: "Warp Amount",  type: "range", min: 0.0, max: 3.0, step: 0.05, default: 3, get: () => warpAmount,  set: (v) => { warpAmount = v; } },
    { label: "Flow Speed",   type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0.01, get: () => flowSpeed,   set: (v) => { flowSpeed = v; } },
    { label: "Swirl Lines",  type: "range", min: 0.0, max: 1.5, step: 0.05, default: 1.25, get: () => swirlLines,  set: (v) => { swirlLines = v; } },
    { label: "Color Speed",  type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.35, get: () => colorSpeed,  set: (v) => { colorSpeed = v; } },
    { label: "Saturation",   type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.95, get: () => saturation,  set: (v) => { saturation = v; } },
    { label: "Brightness",   type: "range", min: 0.2, max: 2.0, step: 0.05, default: 1.45, get: () => brightness,  set: (v) => { brightness = v; } },
    { label: "Rotate",       type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0.01, get: () => rotateSpeed, set: (v) => { rotateSpeed = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uDotDensity: { value: dotDensity },
        uDotSize:    { value: dotSize },
        uWarpAmount: { value: warpAmount },
        uFlowSpeed:  { value: flowSpeed },
        uSwirlLines: { value: swirlLines },
        uSaturation: { value: saturation },
        uColorPhase: { value: colorPhase },
        uBrightness: { value: brightness },
        uRotAngle:   { value: rotAngle },
      },
      vertexShader, fragmentShader, depthTest: false, depthWrite: false,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, elapsed: number) {
    if (!material) return;
    colorPhase += dt * colorSpeed * 0.5;
    rotAngle   += dt * rotateSpeed * 1.5;
    material.uniforms.uTime.value       = elapsed;
    material.uniforms.uDotDensity.value = dotDensity;
    material.uniforms.uDotSize.value    = dotSize;
    material.uniforms.uWarpAmount.value = warpAmount;
    material.uniforms.uFlowSpeed.value  = flowSpeed;
    material.uniforms.uSwirlLines.value = swirlLines;
    material.uniforms.uSaturation.value = saturation;
    material.uniforms.uColorPhase.value = colorPhase;
    material.uniforms.uBrightness.value = brightness;
    material.uniforms.uRotAngle.value   = rotAngle;
  },

  resize(width: number, height: number) {
    if (material) material.uniforms.uResolution.value.set(width, height);
  },

  dispose() {
    geometry?.dispose(); material?.dispose();
    mesh = null; geometry = null; material = null;
  },
};
