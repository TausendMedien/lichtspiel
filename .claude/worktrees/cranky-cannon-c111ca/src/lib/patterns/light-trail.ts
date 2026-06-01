import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

// Controls state
let threshold = 0.29;
let decayRate = 0.015;  // 0 = forever, >0 = fade per frame
let gain = 1.5;
let colorBoost = 2.0;   // 0 = grayscale trails, >1 = vivid color
let dimLevel = 0.30;
let bgMode = 2;         // 0=black, 1=live, 2=dimmed
let clearRequested = false;

// THREE objects
let _renderer: THREE.WebGLRenderer | null = null;

// Video / texture
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let videoTexture: THREE.VideoTexture | null = null;
let blackTexture: THREE.DataTexture | null = null;
let cameraReady = false;

// Ping-pong render targets
let trailA: THREE.WebGLRenderTarget | null = null;
let trailB: THREE.WebGLRenderTarget | null = null;

// Accumulation pass (offscreen scene)
let accumScene: THREE.Scene | null = null;
let accumCamera: THREE.OrthographicCamera | null = null;
let accumGeometry: THREE.PlaneGeometry | null = null;
let accumMaterial: THREE.ShaderMaterial | null = null;

// Composite pass (main scene)
let compositeGeometry: THREE.PlaneGeometry | null = null;
let compositeMaterial: THREE.ShaderMaterial | null = null;
let compositeMesh: THREE.Mesh | null = null;

// DOM overlay
let overlay: HTMLDivElement | null = null;
let canvasRef: HTMLCanvasElement | null = null;

// ─── Shaders ────────────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const accumFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTrail;
  uniform sampler2D uLiveFrame;
  uniform float uThreshold;
  uniform float uDecay;
  uniform float uGain;
  uniform float uColorBoost;
  uniform float uClear;

  void main() {
    vec4 trail = texture2D(uTrail, vUv);
    vec4 live  = texture2D(uLiveFrame, vUv);

    // Use max channel for detection so colored lights (blue, red, etc.)
    // are detected even when their luma is low.
    float brightness = max(max(live.r, live.g), live.b);

    float weight = clamp((brightness - uThreshold) / max(1.0 - uThreshold, 0.01), 0.0, 1.0);
    weight = weight * weight;

    // Boost saturation so colored lights leave vivid trails.
    // uColorBoost=1 is natural; >1 amplifies chroma; 0 = grayscale.
    float gray = dot(live.rgb, vec3(0.299, 0.587, 0.114));
    vec3 vivid = mix(vec3(gray), live.rgb, uColorBoost);

    vec3 contribution = vivid * weight * uGain;
    // Reinhard soft-saturation: scales vector down by 1/(peak+1), preserving hue.
    // Prevents any single frame from slamming the trail to full white.
    float peak = max(max(contribution.r, contribution.g), contribution.b) + 0.001;
    contribution *= peak / (peak + 1.0) / peak;  // = contribution / (peak + 1.0)

    vec3 decayed = trail.rgb * (1.0 - uDecay);

    // No clamp here — HalfFloat buffers hold values > 1.0; tone-map at display time.
    vec3 newTrail = mix(decayed + contribution, vec3(0.0), uClear);
    gl_FragColor = vec4(newTrail, 1.0);
  }
`;

const compositeFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTrail;
  uniform sampler2D uLiveFrame;
  uniform float uBgMode;
  uniform float uDimLevel;
  uniform float uThreshold;

  void main() {
    vec4 trail = texture2D(uTrail, vUv);
    vec4 live  = texture2D(uLiveFrame, vUv);

    float luma = dot(live.rgb, vec3(0.2126, 0.7152, 0.0722));
    float darkness = 1.0 - smoothstep(0.0, uThreshold, luma);

    float t01 = clamp(uBgMode, 0.0, 1.0);
    float t12 = clamp(uBgMode - 1.0, 0.0, 1.0);
    vec3 bg = mix(vec3(0.0), live.rgb, t01);
    bg = mix(bg, live.rgb * uDimLevel * darkness, t12);

    // Reinhard tone-map the accumulated trail so values above 1.0 (from HalfFloat
    // accumulation) compress gracefully rather than hard-clipping to white.
    vec3 toned = trail.rgb / (trail.rgb + 1.0);
    gl_FragColor = vec4(clamp(bg + toned, 0.0, 1.0), 1.0);
  }
`;

// ─── Camera ──────────────────────────────────────────────────────────────────

async function startCamera(canvas: HTMLCanvasElement) {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
      audio: false,
    });
    video = document.createElement("video");
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    video.muted = true;
    await video.play();
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    cameraReady = true;
    overlay?.remove();
    overlay = null;
  } catch {
    cameraReady = false;
    showOverlay(canvas, "Camera access denied.\nAllow camera in browser settings and reload.");
  }
}

function showOverlay(canvas: HTMLCanvasElement, message: string) {
  overlay?.remove();
  const div = document.createElement("div");
  div.style.cssText = `
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:#fff;font-family:sans-serif;font-size:16px;text-align:center;
    pointer-events:none;white-space:pre-line;padding:24px;
    background:rgba(0,0,0,0.55);
  `;
  div.textContent = message;
  canvas.parentElement?.appendChild(div);
  overlay = div;
}

// ─── Pattern ─────────────────────────────────────────────────────────────────

export const lightTrail: Pattern = {
  id: "lightTrail",
  name: "Light Trail",

  controls: [
    {
      label: "Threshold",
      type: "range", min: 0.05, max: 0.95, step: 0.01,
      default: 0.29,
      get: () => threshold,
      set: (v) => { threshold = v; },
    },
    {
      label: "Fade Speed",
      type: "range", min: 0.0, max: 0.3, step: 0.005,
      default: 0.015,
      get: () => decayRate,
      set: (v) => { decayRate = v; },
    },
    {
      label: "Gain",
      type: "range", min: 0.5, max: 8.0, step: 0.1,
      default: 1.5,
      get: () => gain,
      set: (v) => { gain = v; },
    },
    {
      label: "Trail Color",
      type: "range", min: 0.0, max: 4.0, step: 0.1,
      default: 2,
      get: () => colorBoost,
      set: (v) => { colorBoost = v; },
    },
    {
      label: "Dim Level",
      type: "range", min: 0.0, max: 1.0, step: 0.05,
      default: 0.3,
      get: () => dimLevel,
      set: (v) => { dimLevel = v; },
    },
    {
      label: "Background",
      type: "select", options: ["Black", "Live", "Dimmed"],
      get: () => bgMode,
      set: (v) => { bgMode = v; },
    },
    {
      label: "Clear Trails",
      type: "button",
      action: () => { clearRequested = true; },
    },
  ],

  init(ctx: PatternContext) {
    _renderer = ctx.renderer;
    const { width, height } = ctx.size;
    canvasRef = ctx.renderer.domElement;
    const canvas = canvasRef;

    blackTexture = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat
    );
    blackTexture.needsUpdate = true;

    // HalfFloatType avoids 8-bit quantization lock where dim values never decay
    // to zero (e.g. round(4/255 * 0.97) = 4/255 forever). WebGL2 — all modern
    // browsers — supports half-float render targets natively.
    const rtType = _renderer.capabilities.isWebGL2
      ? THREE.HalfFloatType
      : THREE.UnsignedByteType;
    const rtOpts: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: rtType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    trailA = new THREE.WebGLRenderTarget(width, height, rtOpts);
    trailB = new THREE.WebGLRenderTarget(width, height, rtOpts);

    accumScene = new THREE.Scene();
    accumCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    accumGeometry = new THREE.PlaneGeometry(2, 2);
    accumMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTrail:     { value: blackTexture },
        uLiveFrame: { value: blackTexture },
        uThreshold:  { value: threshold },
        uDecay:      { value: decayRate },
        uGain:       { value: gain },
        uColorBoost: { value: colorBoost },
        uClear:      { value: 0.0 },
      },
      vertexShader,
      fragmentShader: accumFragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    const accumMesh = new THREE.Mesh(accumGeometry, accumMaterial);
    accumMesh.frustumCulled = false;
    accumScene.add(accumMesh);

    compositeGeometry = new THREE.PlaneGeometry(2, 2);
    compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTrail:     { value: trailA.texture },
        uLiveFrame: { value: blackTexture },
        uBgMode:    { value: bgMode },
        uDimLevel:  { value: dimLevel },
        uThreshold: { value: threshold },
      },
      vertexShader,
      fragmentShader: compositeFragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    compositeMesh = new THREE.Mesh(compositeGeometry, compositeMaterial);
    compositeMesh.frustumCulled = false;
    ctx.scene.add(compositeMesh);

  },

  activate() {
    if (canvasRef) {
      showOverlay(canvasRef, "Requesting camera access…");
      startCamera(canvasRef);
    }
  },

  update(_dt, _elapsed) {
    if (!_renderer || !accumMaterial || !compositeMaterial) return;

    const liveTex = cameraReady && videoTexture ? videoTexture : blackTexture!;
    if (cameraReady && videoTexture) videoTexture.needsUpdate = true;

    const doClear = clearRequested ? 1.0 : 0.0;
    clearRequested = false;

    accumMaterial.uniforms.uTrail.value     = trailA!.texture;
    accumMaterial.uniforms.uLiveFrame.value = liveTex;
    accumMaterial.uniforms.uThreshold.value  = threshold;
    accumMaterial.uniforms.uDecay.value      = decayRate;
    accumMaterial.uniforms.uGain.value       = gain;
    accumMaterial.uniforms.uColorBoost.value = colorBoost;
    accumMaterial.uniforms.uClear.value      = doClear;

    _renderer.setRenderTarget(trailB);
    _renderer.render(accumScene!, accumCamera!);
    _renderer.setRenderTarget(null);

    [trailA, trailB] = [trailB!, trailA!];

    compositeMaterial.uniforms.uTrail.value     = trailA.texture;
    compositeMaterial.uniforms.uLiveFrame.value = liveTex;
    compositeMaterial.uniforms.uBgMode.value    = bgMode;
    compositeMaterial.uniforms.uDimLevel.value  = dimLevel;
    compositeMaterial.uniforms.uThreshold.value = threshold;
  },

  resize(width, height) {
    trailA?.setSize(width, height);
    trailB?.setSize(width, height);
  },

  dispose() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) { video.pause(); video.srcObject = null; }
    video = null;
    videoTexture?.dispose();
    videoTexture = null;
    blackTexture?.dispose();
    blackTexture = null;
    cameraReady = false;

    trailA?.dispose(); trailA = null;
    trailB?.dispose(); trailB = null;

    accumGeometry?.dispose(); accumGeometry = null;
    accumMaterial?.dispose(); accumMaterial = null;
    accumScene = null; accumCamera = null;

    compositeGeometry?.dispose(); compositeGeometry = null;
    compositeMaterial?.dispose(); compositeMaterial = null;
    compositeMesh = null;

    overlay?.remove(); overlay = null;
    _renderer = null;
  },
};
