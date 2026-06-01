import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

// Controls state
let threshold = 0.29;
let decayRate = 0.015;
let brushRadius = 0.015;  // glow spread in UV space
let gain = 1.0;
let colorBoost = 2.0;
let ghostOpacity = 0.15;  // live camera overlay
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

// Resolution for brush radius conversion
let resX = 1280;
let resY = 720;

// ─── Shaders ────────────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// 9-tap disc sample: center + 8 neighbours scaled by uRadius.
// Each tap detects bright pixels; contributions are summed and averaged
// to produce a soft brush stroke rather than a hard single-pixel trace.
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
  uniform float uRadiusX;  // brushRadius / resX
  uniform float uRadiusY;  // brushRadius / resY

  vec3 detectAt(vec2 uv) {
    vec4 live = texture2D(uLiveFrame, uv);
    float brightness = max(max(live.r, live.g), live.b);
    float weight = clamp((brightness - uThreshold) / max(1.0 - uThreshold, 0.01), 0.0, 1.0);
    weight = weight * weight;
    float gray = dot(live.rgb, vec3(0.299, 0.587, 0.114));
    vec3 vivid = mix(vec3(gray), live.rgb, uColorBoost);
    vec3 c = vivid * weight * uGain;
    // Reinhard soft-saturation: preserves hue, prevents single-frame white slam.
    float peak = max(max(c.r, c.g), c.b) + 0.001;
    return c / (peak + 1.0);
  }

  void main() {
    vec4 trail = texture2D(uTrail, vUv);

    // 9-tap disc (centre + 8 diagonal/cardinal offsets)
    float r = 0.707;
    vec3 contrib = detectAt(vUv);
    contrib += detectAt(vUv + vec2( uRadiusX,        0.0));
    contrib += detectAt(vUv + vec2(-uRadiusX,        0.0));
    contrib += detectAt(vUv + vec2(       0.0,  uRadiusY));
    contrib += detectAt(vUv + vec2(       0.0, -uRadiusY));
    contrib += detectAt(vUv + vec2( uRadiusX * r,  uRadiusY * r));
    contrib += detectAt(vUv + vec2(-uRadiusX * r,  uRadiusY * r));
    contrib += detectAt(vUv + vec2( uRadiusX * r, -uRadiusY * r));
    contrib += detectAt(vUv + vec2(-uRadiusX * r, -uRadiusY * r));
    contrib /= 9.0;

    vec3 decayed = trail.rgb * (1.0 - uDecay);

    // Additive accumulation — HalfFloat supports values > 1.0 for overexposure
    vec3 newTrail = mix(decayed + contrib, vec3(0.0), uClear);
    gl_FragColor = vec4(newTrail, 1.0);
  }
`;

// Reinhard tone-map the accumulated painting so overexposed areas
// bloom smoothly to white, then blend the live ghost over the top.
const compositeFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTrail;
  uniform sampler2D uLiveFrame;
  uniform float uGhost;

  void main() {
    vec3 trail = texture2D(uTrail, vUv).rgb;
    vec3 live  = texture2D(uLiveFrame, vUv).rgb;

    // Reinhard tone-map: handles values above 1.0 gracefully
    vec3 painting = trail / (trail + 1.0);

    vec3 out_ = mix(painting, live, uGhost);
    gl_FragColor = vec4(out_, 1.0);
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

export const lightPaint: Pattern = {
  id: "lightPaint",
  name: "Light Paint",

  controls: [
    {
      label: "Threshold",
      type: "range", min: 0.05, max: 0.95, step: 0.01,
      get: () => threshold,
      set: (v) => { threshold = v; },
    },
    {
      label: "Fade Speed",
      type: "range", min: 0.0, max: 0.3, step: 0.005,
      get: () => decayRate,
      set: (v) => { decayRate = v; },
    },
    {
      label: "Brush Size",
      type: "range", min: 0.0, max: 0.05, step: 0.001,
      get: () => brushRadius,
      set: (v) => { brushRadius = v; },
    },
    {
      label: "Brightness",
      type: "range", min: 0.5, max: 8.0, step: 0.1,
      get: () => gain,
      set: (v) => { gain = v; },
    },
    {
      label: "Trail Color",
      type: "range", min: 0.0, max: 4.0, step: 0.1,
      get: () => colorBoost,
      set: (v) => { colorBoost = v; },
    },
    {
      label: "Ghost",
      type: "range", min: 0.0, max: 1.0, step: 0.05,
      get: () => ghostOpacity,
      set: (v) => { ghostOpacity = v; },
    },
    {
      label: "Clear Canvas",
      type: "button",
      action: () => { clearRequested = true; },
    },
  ],

  init(ctx: PatternContext) {
    _renderer = ctx.renderer;
    const { width, height } = ctx.size;
    resX = width;
    resY = height;
    const canvas = ctx.renderer.domElement;

    blackTexture = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat
    );
    blackTexture.needsUpdate = true;

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
        uTrail:      { value: blackTexture },
        uLiveFrame:  { value: blackTexture },
        uThreshold:  { value: threshold },
        uDecay:      { value: decayRate },
        uGain:       { value: gain },
        uColorBoost: { value: colorBoost },
        uClear:      { value: 0.0 },
        uRadiusX:    { value: brushRadius / resX },
        uRadiusY:    { value: brushRadius / resY },
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
        uGhost:     { value: ghostOpacity },
      },
      vertexShader,
      fragmentShader: compositeFragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    compositeMesh = new THREE.Mesh(compositeGeometry, compositeMaterial);
    compositeMesh.frustumCulled = false;
    ctx.scene.add(compositeMesh);

    showOverlay(canvas, "Requesting camera access…");
    startCamera(canvas);
  },

  update(_dt, _elapsed) {
    if (!_renderer || !accumMaterial || !compositeMaterial) return;

    const liveTex = cameraReady && videoTexture ? videoTexture : blackTexture!;
    if (cameraReady && videoTexture) videoTexture.needsUpdate = true;

    const doClear = clearRequested ? 1.0 : 0.0;
    clearRequested = false;

    accumMaterial.uniforms.uTrail.value      = trailA!.texture;
    accumMaterial.uniforms.uLiveFrame.value  = liveTex;
    accumMaterial.uniforms.uThreshold.value  = threshold;
    accumMaterial.uniforms.uDecay.value      = decayRate;
    accumMaterial.uniforms.uGain.value       = gain;
    accumMaterial.uniforms.uColorBoost.value = colorBoost;
    accumMaterial.uniforms.uClear.value      = doClear;
    accumMaterial.uniforms.uRadiusX.value    = brushRadius / resX;
    accumMaterial.uniforms.uRadiusY.value    = brushRadius / resY;

    _renderer.setRenderTarget(trailB);
    _renderer.render(accumScene!, accumCamera!);
    _renderer.setRenderTarget(null);

    [trailA, trailB] = [trailB!, trailA!];

    compositeMaterial.uniforms.uTrail.value     = trailA.texture;
    compositeMaterial.uniforms.uLiveFrame.value = liveTex;
    compositeMaterial.uniforms.uGhost.value     = ghostOpacity;
  },

  resize(width, height) {
    resX = width;
    resY = height;
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
