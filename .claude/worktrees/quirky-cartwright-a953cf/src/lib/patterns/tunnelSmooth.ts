import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let speed = 10;
let wobble = 0.0;
let ringCount = 42;
let lineThickness = 0.10;
let saturation = 1.0;
let colorSpeed = 0.60;

let colorPhase = 0;
let tunnelOffset = 0;

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
  uniform vec2  uResolution;
  uniform float uOffset;
  uniform float uWobble;
  uniform float uRingCount;
  uniform float uLineWidth;
  uniform float uSaturation;
  uniform float uColorPhase;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 uv = (vUv - 0.5) * vec2(aspect, 1.0);

    float r = length(uv);
    if (r < 0.001) discard;

    float depth = 1.0 / r;

    float wobbleOffset = uWobble * sin(depth * 6.0 - uTime * 2.5) * 0.12;

    // uOffset is accumulated in JS: offset += dt * speed * 0.05
    // Changing speed only affects the rate, never causes a position jump.
    float stripeRaw = (depth + wobbleOffset) * uRingCount * 0.042 - uOffset;
    float stripe    = fract(stripeRaw);

    float rawFw = length(vec2(dFdx(stripeRaw), dFdy(stripeRaw)));
    float fw    = clamp(rawFw, 0.0001, uLineWidth * 0.45);
    float lw    = uLineWidth;
    float line  = smoothstep(0.0, fw, stripe)
                - smoothstep(max(lw - fw, fw), lw, stripe);

    float fade = 1.0 - smoothstep(1.5, 2.5, rawFw / lw);
    line *= fade;

    float centerFade = smoothstep(0.0, 0.10, r);
    line *= centerFade;

    if (line < 0.01) discard;

    float hue = 0.665 + sin(uColorPhase) * 0.165;
    float lit = 0.55 + 0.15 * sin(uTime * 0.4 + depth * 0.2);
    vec3 col = hsl2rgb(hue, 1.0, lit);

    col = mix(vec3(1.0), col, uSaturation);

    float pulse = mix(1.0, 0.85 + 0.15 * sin(uTime * 2.0 + stripe * 12.0), uSaturation);
    col *= pulse * line;

    gl_FragColor = vec4(col, line);
  }
`;

export const tunnelSmooth: Pattern = {
  id: "tunnelSmooth",
  name: "Tunnel — Smooth",
  controls: [
    { label: "Speed",       type: "range", min: -100, max: 100, step: 1, default: 10,    get: () => speed,         set: (v) => { speed = v; } },
    { label: "Wobble",      type: "range", min: 0,    max: 1.0, step: 0.05, default: 0, get: () => wobble,        set: (v) => { wobble = v; } },
    { label: "Ring Count",  type: "range", min: 1,    max: 50,  step: 1, default: 42,    get: () => ringCount,     set: (v) => { ringCount = v; } },
    { label: "Thickness",   type: "range", min: 0.02, max: 0.5, step: 0.02, default: 0.1, get: () => lineThickness, set: (v) => { lineThickness = v; } },
    { label: "Saturation",  type: "range", min: 0.0,  max: 1.0, step: 0.05, default: 1, get: () => saturation,    set: (v) => { saturation = v; } },
    { label: "Color Speed", type: "range", min: 0.0,  max: 1.0, step: 0.05, default: 0.6, get: () => colorSpeed,    set: (v) => { colorSpeed = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uOffset:     { value: tunnelOffset },
        uWobble:     { value: wobble },
        uRingCount:  { value: ringCount },
        uLineWidth:  { value: lineThickness },
        uSaturation: { value: saturation },
        uColorPhase: { value: colorPhase },
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

  update(dt: number, elapsed: number) {
    if (!material) return;
    colorPhase += dt * colorSpeed * 0.3;
    tunnelOffset += dt * speed * 0.05;
    material.uniforms.uTime.value       = elapsed;
    material.uniforms.uOffset.value     = tunnelOffset;
    material.uniforms.uWobble.value     = wobble;
    material.uniforms.uRingCount.value  = ringCount;
    material.uniforms.uLineWidth.value  = lineThickness;
    material.uniforms.uSaturation.value = saturation;
    material.uniforms.uColorPhase.value = colorPhase;
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
