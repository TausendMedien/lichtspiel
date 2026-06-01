import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let speed = 0.5;
let wobble = 0.0;      // 0 = clean concentric rings; >0 = rings breathe against each other
let ringCount = 9;
let lineThickness = 0.5;
let saturation = 0.90;
let colorSpeed = 0.60;

let colorPhase = 0;

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
  uniform float uSpeed;
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

    // Perspective depth: 1/r gives large rings close, small rings far.
    float depth = 1.0 / r;

    // Wobble: radial standing wave — each ring's apparent radius oscillates
    // at a phase offset based on its depth, so rings breathe against each other.
    // No atan/angle involved → no center discontinuity or blinking.
    float wobbleOffset = uWobble * sin(depth * 6.0 - uTime * 2.5) * 0.12;

    // uRingCount directly = number of visible rings on screen.
    float stripe = fract((depth + wobbleOffset) * uRingCount * 0.042 - uTime * uSpeed * 0.05);

    // Screen-adaptive AA. Raw fwidth grows huge near center (many rings per
    // pixel). Clamp it so rings stay visible, but also compute a fade that
    // gracefully dissolves rings to black before they alias into a snowflake.
    float rawFw = fwidth(stripe);
    float fw    = clamp(rawFw, 0.0001, uLineWidth * 0.45);
    float lw    = uLineWidth;
    float line  = smoothstep(0.0, fw, stripe)
                - smoothstep(max(lw - fw, fw), lw, stripe);

    // Fade to black when rings become too dense. Threshold at 1.5× keeps rings
    // visible much closer to centre (≈half the previous hole radius).
    float fade = 1.0 - smoothstep(1.5, 2.5, rawFw / lw);
    line *= fade;

    if (line < 0.01) discard;

    // Hue oscillates smoothly via sin() — no fract() wrap → no abrupt jumps.
    float hue = 0.665 + sin(uColorPhase) * 0.165;
    float lit = 0.55 + 0.15 * sin(uTime * 0.4 + depth * 0.2);
    vec3 col = hsl2rgb(hue, 1.0, lit);

    // saturation=0 → pure white lines; saturation=1 → full color.
    col = mix(vec3(1.0), col, uSaturation);

    // At saturation=0 pulse→1.0 so white lines are not dimmed.
    float pulse = mix(1.0, 0.85 + 0.15 * sin(uTime * 2.0 + stripe * 12.0), uSaturation);
    col *= pulse * line;

    gl_FragColor = vec4(col, line);
  }
`;

export const tunnel: Pattern = {
  id: "tunnel",
  name: "Tunnel",
  controls: [
    { label: "Speed",       type: "range", min: -100, max: 100, step: 1,    get: () => speed,         set: (v) => { speed = v; } },
    { label: "Wobble",      type: "range", min: 0,    max: 1.0, step: 0.05, get: () => wobble,        set: (v) => { wobble = v; } },
    { label: "Ring Count",  type: "range", min: 1,    max: 50,  step: 1,    get: () => ringCount,     set: (v) => { ringCount = v; } },
    { label: "Thickness",   type: "range", min: 0.02, max: 0.5, step: 0.02, get: () => lineThickness, set: (v) => { lineThickness = v; } },
    { label: "Saturation",  type: "range", min: 0.0,  max: 1.0, step: 0.05, get: () => saturation,    set: (v) => { saturation = v; } },
    { label: "Color Speed", type: "range", min: 0.0,  max: 1.0, step: 0.05, get: () => colorSpeed,    set: (v) => { colorSpeed = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uSpeed:      { value: speed },
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
    material.uniforms.uTime.value       = elapsed;
    material.uniforms.uSpeed.value      = speed;
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
