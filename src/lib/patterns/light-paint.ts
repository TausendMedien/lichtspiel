import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2, colorShuffle, getColorByIndex } from "../colorC2.svelte";
import { interactionState } from "../interactionState.svelte";
import { privacyMode } from "../privacyMode.svelte";
import { acquireCamera, type CameraHandle } from "../cameraManager";
import { cameraState, enumerateCameras, saveCameraDevice, getVisibleDevices, cameraFeedConstraints } from "../globalCameraSettings.svelte";

// ─── Shared camera device state ───────────────────────────────────────────────
// Backed by the global cameraState so every pattern honors the user's chosen
// device (see globalCameraSettings.svelte.ts).

// ── "Light Painting" family ──────────────────────────────────────────────────
// A webcam frame feeds a feedback loop: the accumulation pass adds pixels
// brighter than a threshold onto a decaying buffer (with a soft brush + spatial
// feedback transforms), the composite pass tone-maps it with background / ghost
// / colour / glow / split / kaleidoscope looks.
//
// `createLightPainting()` builds an independent pattern instance (its own state +
// GL objects) so several preset tiles can coexist. Brush Size = 0 gives a sharp
// "Light Trail" look; raise it for a soft brush.

// ─── Heat map (shared helper) ──────────────────────────────────────────────────
// Light-painting patterns already have their own live camera feed — Heat reuses
// that same video element (no second getUserMedia stream) and derives a motion
// field from simple frame-to-frame luma differencing, at the same 160x90
// resolution the static heat-reactive patterns (tunnel.ts et al) use.

const HEAT_W = 160, HEAT_H = 90;

function heatBoxBlur(src: Float32Array, tmp: Float32Array, dst: Float32Array, r: number) {
  if (r < 1) { dst.set(src); return; }
  for (let y = 0; y < HEAT_H; y++) {
    const yo = y * HEAT_W;
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, HEAT_W - 1); k++) { sum += src[yo + k]; cnt++; }
    tmp[yo] = sum / cnt;
    for (let x = 1; x < HEAT_W; x++) {
      if (x + r < HEAT_W)      { sum += src[yo + x + r];     cnt++; }
      if (x - r - 1 >= 0) { sum -= src[yo + x - r - 1]; cnt--; }
      tmp[yo + x] = sum / cnt;
    }
  }
  for (let x = 0; x < HEAT_W; x++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, HEAT_H - 1); k++) { sum += tmp[k * HEAT_W + x]; cnt++; }
    dst[x] = sum / cnt;
    for (let y = 1; y < HEAT_H; y++) {
      if (y + r < HEAT_H)      { sum += tmp[(y + r) * HEAT_W + x];     cnt++; }
      if (y - r - 1 >= 0) { sum -= tmp[(y - r - 1) * HEAT_W + x]; cnt--; }
      dst[y * HEAT_W + x] = sum / cnt;
    }
  }
}

// ─── Shaders (shared, immutable) ──────────────────────────────────────────────

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// 9-tap disc sample: center + 8 neighbours scaled by uRadius.
// Bright pixels are detected, summed and averaged → a soft brush stroke.
// The previous trail is read through a feedback transform (vortex rotation +
// fly-in/out scale) so the accumulated light flows through space.
const accumFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTrail;
  uniform sampler2D uLiveFrame;
  uniform float uThreshold;
  uniform float uDecay;
  uniform float uGain;
  uniform float uClear;
  uniform float uRadiusX;    // brushRadius / resX
  uniform float uRadiusY;    // brushRadius / resY
  uniform float uTrailSoftX; // trailSoft / resX
  uniform float uTrailSoftY; // trailSoft / resY
  uniform float uFlow;     // -1 fly in … 1 fly out
  uniform float uVortex;   // rotation radians/frame
  uniform float uMirror;   // >0.5 = mirror live feed horizontally

  vec3 detectAt(vec2 uv) {
    vec2 luv = vec2(uMirror > 0.5 ? 1.0 - uv.x : uv.x, uv.y);
    vec4 live = texture2D(uLiveFrame, luv);
    float brightness = max(max(live.r, live.g), live.b);
    float weight = clamp((brightness - uThreshold) / max(1.0 - uThreshold, 0.01), 0.0, 1.0);
    weight = weight * weight;
    // Natural camera colour (no chroma boost) — colour styling happens at composite.
    vec3 c = live.rgb * weight * uGain;
    // Reinhard soft-saturation: preserves hue, prevents single-frame white slam.
    float peak = max(max(c.r, c.g), c.b) + 0.001;
    return c / (peak + 1.0);
  }

  void main() {
    // Feedback transform on the previous trail (rotate then scale about centre).
    vec2 fb = vUv - 0.5;
    float a = uVortex;
    float s = sin(a), co = cos(a);
    fb = mat2(co, -s, s, co) * fb;
    fb *= (1.0 - uFlow * 0.02);   // -1 => content flies IN, +1 => flies OUT
    // Skip trail blur on pixels currently lit by the camera — keeps static bright
    // areas (faces, walls) sharp while only smoothing the fading motion trail.
    vec2 liveUv = vec2(uMirror > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
    vec4 liveCheck = texture2D(uLiveFrame, liveUv);
    float liveBright = max(max(liveCheck.r, liveCheck.g), liveCheck.b);
    bool currentlyLit = liveBright > uThreshold;

    vec2 center = fb + 0.5;
    vec4 trail;
    if (uTrailSoftX > 0.001 && !currentlyLit) {
      vec2 d = vec2(uTrailSoftX, uTrailSoftY);
      trail  = texture2D(uTrail, center)                         * 0.36;
      trail += texture2D(uTrail, center + vec2( d.x,  0.0))     * 0.12;
      trail += texture2D(uTrail, center + vec2(-d.x,  0.0))     * 0.12;
      trail += texture2D(uTrail, center + vec2( 0.0,  d.y))     * 0.12;
      trail += texture2D(uTrail, center + vec2( 0.0, -d.y))     * 0.12;
      trail += texture2D(uTrail, center + vec2( d.x,  d.y))     * 0.04;
      trail += texture2D(uTrail, center + vec2(-d.x,  d.y))     * 0.04;
      trail += texture2D(uTrail, center + vec2( d.x, -d.y))     * 0.04;
      trail += texture2D(uTrail, center + vec2(-d.x, -d.y))     * 0.04;
    } else {
      trail = texture2D(uTrail, center);
    }

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

// Separable 9-tap Gaussian blur (used twice: horizontal then vertical) for bloom.
const blurFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec2 uDir;   // texel * spread along one axis
  void main() {
    vec3 sum = texture2D(uTex, vUv).rgb * 0.2270270;
    sum += (texture2D(uTex, vUv + uDir * 1.0).rgb + texture2D(uTex, vUv - uDir * 1.0).rgb) * 0.1945946;
    sum += (texture2D(uTex, vUv + uDir * 2.0).rgb + texture2D(uTex, vUv - uDir * 2.0).rgb) * 0.1216216;
    sum += (texture2D(uTex, vUv + uDir * 3.0).rgb + texture2D(uTex, vUv - uDir * 3.0).rgb) * 0.0540541;
    sum += (texture2D(uTex, vUv + uDir * 4.0).rgb + texture2D(uTex, vUv - uDir * 4.0).rgb) * 0.0162162;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

// Colour styling reuses the app-wide "Colors v2" curve (uColorsV2):
//   v2=0 grayscale · v2=1 single main-colour tint · v2=3 = the Colorize result.
// Colorize blends Live (0) ↔ the 3-colour Custom palette gradient (1), so v2=3
// gives live (Colorize 0) or full custom colours (Colorize 1). Colorize=0 makes
// the whole expression collapse back to the stock pipeline (v2=3 = untouched live).
const compositeFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTrail;
  uniform sampler2D uBloomTex;
  uniform sampler2D uLiveFrame;
  uniform float uBlack;        // 0 = full live feed, 1 = black
  uniform float uThreshold;
  uniform float uGhost;
  uniform float uColorize;     // 0 live colour … 1 custom palette
  uniform float uColorsV2;     // global recolor curve (0 gray … 3 = colorize result)
  uniform float uBrightness;    // palette brightness scale (colorShuffle)
  uniform float uBrightnessMult; // audio-driven output multiplier
  uniform vec3  uPal0;         // shuffle-assigned colour 0
  uniform vec3  uPal1;         // shuffle-assigned colour 1
  uniform vec3  uPal2;         // shuffle-assigned colour 2
  uniform float uBloom;
  uniform float uRgbSplit;
  uniform float uMirror;       // >0.5 = mirror live feed horizontally
  uniform float uKaleido;      // >0.5 = on
  uniform float uKaleidoSeg;
  uniform vec2  uHeatOffset;   // Center Shift: pans the whole image toward the person
  uniform sampler2D uHeatMap;  // 160x90 smoothed motion field (same layout as static patterns)
  uniform float uHeatStrength; // Sobel edge warp magnitude, 0 = off

  // Reinhard-toned trail + bloom at a given uv.
  vec3 tonedAt(vec2 uv) {
    vec3 t = texture2D(uTrail, uv).rgb;
    t += uBloom * texture2D(uBloomTex, uv).rgb;
    return t / (t + 1.0);
  }

  vec2 kaleido(vec2 uv) {
    vec2 p = uv - 0.5;
    float ang = atan(p.y, p.x);
    float rad = length(p);
    float seg = 6.2831853 / uKaleidoSeg;
    ang = mod(ang, seg);
    ang = abs(ang - seg * 0.5);
    return vec2(cos(ang), sin(ang)) * rad + 0.5;
  }

  void main() {
    vec2 suv = uKaleido > 0.5 ? kaleido(vUv) : vUv;
    suv -= uHeatOffset;

    // Heat Sobel: locally warps the image at body-motion edges, same technique as
    // the static heat-reactive patterns (tunnel.ts et al). The heat texture comes
    // from a 2D canvas readback (row 0 = top), so flip both axes to align it with
    // vUv (0 = bottom) the way tunnel.ts does.
    if (uHeatStrength > 0.001) {
      vec2 eps = vec2(1.5 / 160.0, 1.5 / 90.0);
      vec2 hUv = vec2(1.0 - suv.x, 1.0 - suv.y);
      float hL = texture2D(uHeatMap, clamp(hUv - vec2(eps.x, 0.0), 0.0, 1.0)).r;
      float hR = texture2D(uHeatMap, clamp(hUv + vec2(eps.x, 0.0), 0.0, 1.0)).r;
      float hD = texture2D(uHeatMap, clamp(hUv - vec2(0.0, eps.y), 0.0, 1.0)).r;
      float hU = texture2D(uHeatMap, clamp(hUv + vec2(0.0, eps.y), 0.0, 1.0)).r;
      suv += vec2(hR - hL, hU - hD) * uHeatStrength * 0.3;
    }

    // Chromatic split across channels.
    vec3 toned;
    toned.r = tonedAt(suv + vec2(uRgbSplit, 0.0)).r;
    toned.g = tonedAt(suv).g;
    toned.b = tonedAt(suv - vec2(uRgbSplit, 0.0)).b;

    // Colour styling: Colors v2 curve with the Colorize blend as its v2=3 endpoint.
    float luma = dot(toned, vec3(0.299, 0.587, 0.114));
    vec3 palGrad = ((luma < 0.5)
      ? mix(uPal0, uPal1, luma * 2.0)
      : mix(uPal1, uPal2, (luma - 0.5) * 2.0)) * luma * uBrightness;
    vec3 colorizeResult = mix(toned, palGrad, uColorize);
    vec3 gray = vec3(luma);
    vec3 mono = uPal0 * (0.2 + luma * 0.8) * uBrightness;
    float ph1 = clamp(uColorsV2, 0.0, 1.0);
    float ph2 = clamp((uColorsV2 - 1.0) / 2.0, 0.0, 1.0);
    vec3 colored = mix(mix(gray, mono, ph1), colorizeResult, ph2);

    // Background from the (optionally mirrored) live feed.
    vec2 bguv = vec2(uMirror > 0.5 ? 1.0 - suv.x : suv.x, suv.y);
    vec4 live = texture2D(uLiveFrame, bguv);
    vec3 bg = live.rgb * (1.0 - uBlack);

    vec3 outc = clamp((bg + colored) * uBrightnessMult, 0.0, 1.0);
    outc = mix(outc, live.rgb, uGhost);
    gl_FragColor = vec4(outc, 1.0);
  }
`;

// ─── Preset defaults ──────────────────────────────────────────────────────────

interface LPDefaults {
  threshold: number;
  decayRate: number;
  gain: number;
  colorize: number;
  brushRadius: number;
  black: number;
  ghostOpacity: number;
  flow: number;
  vortex: number;
  bloom: number;
  rgbSplit: number;
  kaleidoOn: boolean;
  kaleidoSeg: number;
  mirror: boolean;
}

// ─── Module-level threshold lock (shared across all instances) ────────────────
let _thresholdLocked = false;
let _lockedThreshold = 0.80;
const _thresholdSetters: Array<(v: number) => void> = [];

const BASE_DEFAULTS: LPDefaults = {
  threshold: 0.80,
  decayRate: 0.01,
  gain: 0.5,
  colorize: 0,
  brushRadius: 0.012,
  black: 0.70,      // 0 = full live feed, 1 = black
  ghostOpacity: 0,
  flow: 0,
  vortex: 0,
  bloom: 0,
  rgbSplit: 0,
  kaleidoOn: false,
  kaleidoSeg: 6,
  mirror: true,     // default mirrored (selfie-correct: move left → reads left)
};

// ─── Factory ──────────────────────────────────────────────────────────────────

function createLightPainting(
  id: string,
  name: string,
  overrides: Partial<LPDefaults> = {},
  priorityLabels: string[] = [],
): Pattern {
  const D: LPDefaults = { ...BASE_DEFAULTS, ...overrides };

  // Controls state
  let threshold = D.threshold;
  let decayRate = D.decayRate;
  let gain = D.gain;
  let colorize = D.colorize;
  let brushRadius = D.brushRadius;
  let trailSoft = 0.0;
  let black = D.black;
  let ghostOpacity = D.ghostOpacity;
  let flow = D.flow;
  let vortex = D.vortex;
  let bloom = D.bloom;
  let rgbSplit = D.rgbSplit;
  let kaleidoOn = D.kaleidoOn;
  let kaleidoSeg = D.kaleidoSeg;
  let mirror = D.mirror;
  let clearRequested = false;
  const halfResBlur = true;  // always on — saves ~75% of GPU blur work

  // Heat state — reuses this instance's own camera feed (see HEAT_W/HEAT_H helpers above)
  let heatCenterStr = 1.0;
  let heatStrength  = 1.8;
  let heatBlurR     = 1;
  const heatOffset  = new THREE.Vector2();
  let heatDiffCanvas: HTMLCanvasElement | null = null;
  let heatDiffCtx: CanvasRenderingContext2D | null = null;
  let heatPrevLuma: Float32Array | null = null;
  let heatLastVideoTime = -1;
  let heatRaw: Float32Array | null = null;
  let heatSmoothed: Float32Array | null = null;
  let heatTmp: Float32Array | null = null;
  let heatTexData: Float32Array | null = null;
  let heatTex: THREE.DataTexture | null = null;

  function computeHeatCentroid(): { cx: number; cy: number } {
    const map = heatSmoothed!;
    let wx = 0, wy = 0, total = 0;
    for (let y = 0; y < HEAT_H; y++)
      for (let x = 0; x < HEAT_W; x++) {
        const v = map[y * HEAT_W + x];
        wx += v * x; wy += v * y; total += v;
      }
    return total > 0.01
      ? { cx: wx / total / HEAT_W, cy: wy / total / HEAT_H }
      : { cx: 0.5, cy: 0.5 };
  }

  // Frame-to-frame luma diff on this instance's own video element — no extra
  // getUserMedia stream. Only runs while Heat is on (extra CPU cost otherwise).
  function tickHeatDiff() {
    if (!video || !heatDiffCtx || !heatRaw) return;
    if (video.readyState < 2 || video.currentTime === heatLastVideoTime) return;
    heatLastVideoTime = video.currentTime;
    heatDiffCtx.drawImage(video, 0, 0, HEAT_W, HEAT_H);
    const { data } = heatDiffCtx.getImageData(0, 0, HEAT_W, HEAT_H);
    const luma = new Float32Array(HEAT_W * HEAT_H);
    for (let i = 0; i < HEAT_W * HEAT_H; i++) {
      luma[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    }
    if (heatPrevLuma) {
      for (let i = 0; i < HEAT_W * HEAT_H; i++) heatRaw[i] = Math.abs(luma[i] - heatPrevLuma[i]);
    }
    heatPrevLuma = luma;
  }

  // THREE objects
  let _renderer: THREE.WebGLRenderer | null = null;

  // Video / texture
  let cameraHandle: CameraHandle | null = null;
  let video: HTMLVideoElement | null = null;
  let videoTexture: THREE.VideoTexture | null = null;
  let blackTexture: THREE.DataTexture | null = null;
  let cameraReady = false;
  let startId = 0;

  // Ping-pong render targets
  let trailA: THREE.WebGLRenderTarget | null = null;
  let trailB: THREE.WebGLRenderTarget | null = null;
  let bloomA: THREE.WebGLRenderTarget | null = null;
  let bloomB: THREE.WebGLRenderTarget | null = null;

  // Accumulation pass (offscreen scene)
  let accumScene: THREE.Scene | null = null;
  let accumCamera: THREE.OrthographicCamera | null = null;
  let accumGeometry: THREE.PlaneGeometry | null = null;
  let accumMaterial: THREE.ShaderMaterial | null = null;

  // Blur pass
  let blurScene: THREE.Scene | null = null;
  let blurGeometry: THREE.PlaneGeometry | null = null;
  let blurMaterial: THREE.ShaderMaterial | null = null;

  // Composite pass (main scene)
  let compositeGeometry: THREE.PlaneGeometry | null = null;
  let compositeMaterial: THREE.ShaderMaterial | null = null;
  let compositeMesh: THREE.Mesh | null = null;

  // DOM overlay
  let overlay: HTMLDivElement | null = null;
  let overlayTimeout: ReturnType<typeof setTimeout> | null = null;
  let canvasRef: HTMLCanvasElement | null = null;

  // Resolution for brush radius / bloom texel conversion
  let resX = 1280;
  let resY = 720;

  function stopCamera() {
    ++startId; // invalidate any in-flight startCamera
    if (overlayTimeout) { clearTimeout(overlayTimeout); overlayTimeout = null; }
    cameraHandle?.release();
    cameraHandle = null;
    video = null;
    videoTexture?.dispose();
    videoTexture = null;
    cameraReady = false;
    overlay?.remove();
    overlay = null;
  }

  // Recovery: device unplugged, OS revoked permission, or the track otherwise dies mid-
  // session (sleep/wake) — restart immediately if this instance is still the active camera.
  function onCameraEnded(myId: number, canvas: HTMLCanvasElement) {
    if (myId !== startId) return;
    stopCamera();
    if (!privacyMode.active) startCamera(canvas);
  }

  async function startCamera(canvas: HTMLCanvasElement) {
    if (privacyMode.active) return;
    const myId = ++startId;
    // Show "Requesting…" only if camera hasn't started within 500ms (avoids a flash when already granted)
    overlayTimeout = setTimeout(() => {
      if (myId === startId) showOverlay(canvas, 'Requesting camera access…');
    }, 500);
    // Enumerate cameras so device picker is populated on first use
    if (cameraState.devices.length === 0) await enumerateCameras();
    try {
      const handle = await acquireCamera(id, cameraFeedConstraints(), () => onCameraEnded(myId, canvas));
      clearTimeout(overlayTimeout!); overlayTimeout = null;
      if (myId !== startId) { handle.release(); return; }
      cameraHandle = handle;
      video = handle.video;
      videoTexture = new THREE.VideoTexture(video);
      videoTexture.minFilter = THREE.LinearFilter;
      videoTexture.magFilter = THREE.LinearFilter;
      cameraReady = true;
      overlay?.remove();
      overlay = null;
    } catch {
      clearTimeout(overlayTimeout!); overlayTimeout = null;
      if (myId !== startId) return;
      cameraReady = false;
      showOverlay(canvas, "Camera access denied.\nAllow camera in browser settings, then retry.", () => startCamera(canvas));
    }
  }

  function showOverlay(canvas: HTMLCanvasElement, message: string, onRetry?: () => void) {
    overlay?.remove();
    const div = document.createElement("div");
    div.style.cssText = `
      position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
      color:#fff;font-family:sans-serif;font-size:16px;text-align:center;
      pointer-events:${onRetry ? "auto" : "none"};white-space:pre-line;padding:24px;
      background:rgba(0,0,0,0.55);
    `;
    const msg = document.createElement("div");
    msg.textContent = message;
    div.appendChild(msg);
    if (onRetry) {
      const btn = document.createElement("button");
      btn.textContent = "↻ Retry";
      btn.style.cssText = "pointer-events:auto;cursor:pointer;padding:6px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.08);color:#fff;font-size:13px;font-family:sans-serif;";
      btn.onclick = onRetry;
      div.appendChild(btn);
    }
    canvas.parentElement?.appendChild(div);
    overlay = div;
  }

  // Register this instance's threshold setter for the lock mechanism (once, at creation).
  const thresholdSetter = (v: number) => { threshold = v; };
  _thresholdSetters.push(thresholdSetter);

  // Camera device picker lives in Interactive section; camera is always on for these patterns.
  const cameraControls = [
    {
      label: "Camera Device",
      type: "select" as const,
      interactive: "camera" as const,
      tip: "Which camera feeds the light-painting input.",
      options: () => getVisibleDevices().length > 0 ? getVisibleDevices().map(d => d.label) : ['Default'],
      get: () => {
        const idx = getVisibleDevices().findIndex(d => d.deviceId === cameraState.deviceId);
        return idx >= 0 ? idx : 0;
      },
      set: (idx: number) => {
        cameraState.deviceId = getVisibleDevices()[idx]?.deviceId ?? '';
        saveCameraDevice();
        if (canvasRef) startCamera(canvasRef);
      },
    },
  ];

  const baseControls = [
        ...cameraControls,
        {
          label: "Mirror",
          type: "toggle" as const,
          tip: "Flip the camera horizontally (selfie view).",
          get: () => mirror,
          set: (v: boolean) => { mirror = !!v; },
        },
        {
          label: "Threshold",
          type: "range" as const, min: 0.05, max: 0.95, step: 0.01,
          default: D.threshold,
          tip: "How bright a pixel must be to leave a trail. Higher = only the brightest light paints.",
          get: () => threshold,
          set: (v: number) => {
            threshold = v;
            if (_thresholdLocked) {
              _lockedThreshold = v;
              _thresholdSetters.forEach(s => { if (s !== thresholdSetter) s(v); });
            }
          },
        },
        {
          label: "Lock",
          type: "toggle" as const,
          title: "Apply to all Light Painting Patterns",
          tip: "Apply this threshold to all Light Painting patterns at once.",
          linkedTo: "Threshold",
          get: () => _thresholdLocked,
          set: (v: boolean) => {
            _thresholdLocked = !!v;
            if (v) { _lockedThreshold = threshold; _thresholdSetters.forEach(s => s(threshold)); }
          },
        },
        {
          label: "Fade Speed",
          type: "range" as const, min: 0.001, max: 0.1, step: 0.001,
          default: D.decayRate,
          tip: "How fast trails fade out. Higher = shorter trails.",
          get: () => decayRate,
          set: (v: number) => { decayRate = Math.min(0.1, Math.max(0.001, v)); },
        },
        {
          label: "Colorize Light",
          type: "range" as const, min: 0.0, max: 1.0, step: 0.05,
          default: D.colorize,
          tip: "Recolour trails from their real camera colour (0) toward the palette gradient (1). Acts on the trails before the frame is finished — if \"Apply Colors\" is also on, the whole image is then remapped onto your palette again, so high values + Apply Colors can double up and oversaturate.",
          get: () => colorize,
          set: (v: number) => { colorize = v; },
        },
        {
          label: "Black",
          type: "range" as const, min: 0.0, max: 1.0, step: 0.01,
          default: D.black,
          tip: "Darken the live background behind the trails. 1 = pure black, only trails visible.",
          get: () => black,
          set: (v: number) => { black = v; },
        },
        // ─── Additional settings (collapsible) ───────────────────────────────
        {
          label: "Additional",
          type: "section" as const,
          collapsible: true,
          get: () => true,
          set: (_v: boolean) => {},
        },
        {
          label: "Gain",
          type: "range" as const, min: 0.5, max: 8.0, step: 0.1,
          default: D.gain,
          tip: "Amplify the camera signal so dimmer light still paints.",
          get: () => gain,
          set: (v: number) => { gain = v; },
        },
        {
          label: "Brush Size",
          type: "range" as const, min: 0.0, max: 0.05, step: 0.001,
          default: D.brushRadius,
          tip: "Softness/spread of each painted point. 0 = sharp, higher = soft glow.",
          get: () => brushRadius,
          set: (v: number) => { brushRadius = v; },
        },
        {
          label: "Trail Soft",
          type: "range" as const, min: 0.0, max: 2.0, step: 0.25,
          default: 0,
          exp: true as const,
          tip: "Extra blur on fading trails (experimental).",
          get: () => trailSoft,
          set: (v: number) => { trailSoft = v; },
        },
        {
          label: "Ghost",
          type: "range" as const, min: 0.0, max: 1.0, step: 0.05,
          default: D.ghostOpacity,
          tip: "Overlay a faint live camera image on top of the trails.",
          get: () => ghostOpacity,
          set: (v: number) => { ghostOpacity = v; },
        },
        {
          label: "Bloom",
          type: "range" as const, min: 0.0, max: 1.0, step: 0.05,
          default: D.bloom,
          tip: "Glow/halo around bright trails.",
          get: () => bloom,
          set: (v: number) => { bloom = v; },
        },
        // Separator ends the "Additional" section scope so controls below are always visible
        { label: "", type: "separator" as const },
        {
          label: "Fly In/Out",
          type: "range" as const, min: -1.0, max: 1.0, step: 0.01,
          default: D.flow,
          tip: "Slowly zoom the accumulated image — negative pulls trails in, positive pushes out.",
          get: () => flow,
          set: (v: number) => { flow = v; },
        },
        {
          label: "Vortex",
          type: "range" as const, min: -1.0, max: 1.0, step: 0.01,
          default: D.vortex,
          tip: "Slowly rotate the accumulated image — sign sets spin direction.",
          get: () => vortex,
          set: (v: number) => { vortex = v; },
        },
        {
          label: "RGB Split",
          type: "range" as const, min: 0.0, max: 0.05, step: 0.001,
          default: D.rgbSplit,
          tip: "Chromatic aberration: offset red/blue channels for a glitch look.",
          get: () => rgbSplit,
          set: (v: number) => { rgbSplit = v; },
        },
        {
          label: "Kaleidoscope",
          type: "toggle" as const,
          tip: "Mirror the image into radial segments.",
          get: () => kaleidoOn,
          set: (v: boolean) => { kaleidoOn = !!v; },
        },
        {
          label: "Segments",
          type: "range" as const, min: 2, max: 12, step: 1,
          default: D.kaleidoSeg,
          disabled: () => !kaleidoOn,
          tip: "Number of kaleidoscope wedges.",
          get: () => kaleidoSeg,
          set: (v: number) => { kaleidoSeg = v; },
        },
        {
          label: "Clear Canvas",
          type: "button" as const,
          tip: "Erase all accumulated trails now.",
          action: () => { clearRequested = true; },
        },
        {
          label: "Center Shift", type: "range" as const, min: 0, max: 2, step: 0.1, default: 1.0,
          interactive: 'heat' as const,
          tip: "How much heat-map position shifts the image center toward the person. Requires Heat.",
          get: () => heatCenterStr, set: v => { heatCenterStr = v; },
        },
        {
          label: "Heat Strength", type: "range" as const, min: 0, max: 2.5, step: 0.1, default: 1.8,
          interactive: 'heat' as const,
          tip: "How much heat-map edges locally warp the image. Requires Heat.",
          get: () => heatStrength, set: v => { heatStrength = v; },
        },
        {
          label: "Blur Radius", type: "range" as const, min: 0, max: 8, step: 1, default: 1,
          interactive: 'heat' as const,
          tip: "Radius of heat-map blur — larger = broader glow around motion zones. Requires Heat.",
          get: () => heatBlurR, set: v => { heatBlurR = v; },
        },
      ];

  // Move priority controls to position 1 (after the 1 camera control that is in Interactive).
  // This puts the distinctive slider first in the Controls panel.
  const builtControls = (() => {
    if (priorityLabels.length > 0) {
      const priorityItems = baseControls.filter(c => priorityLabels.includes(c.label));
      const rest = baseControls.filter(c => !priorityLabels.includes(c.label));
      return [...rest.slice(0, 1), ...priorityItems, ...rest.slice(1)];
    }
    return baseControls;
  })();

  return {
    id,
    name,
    usesCameraBlend: true,
    heatReactive: true,
    audioControlLabels: ['RGB Split'],
    defaultCollapsedSections: ['Additional'],
    controls: builtControls,

    init(ctx: PatternContext) {
      _renderer = ctx.renderer;
      const { width, height } = ctx.size;
      resX = width;
      resY = height;
      canvasRef = ctx.renderer.domElement;
      // Start camera immediately so demo mode auto-advance doesn't stay dark
      if (!privacyMode.active) startCamera(canvasRef);

      blackTexture = new THREE.DataTexture(
        new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat
      );
      blackTexture.needsUpdate = true;

      heatDiffCanvas = document.createElement("canvas");
      heatDiffCanvas.width = HEAT_W;
      heatDiffCanvas.height = HEAT_H;
      heatDiffCtx = heatDiffCanvas.getContext("2d", { willReadFrequently: true });
      heatRaw      = new Float32Array(HEAT_W * HEAT_H);
      heatSmoothed = new Float32Array(HEAT_W * HEAT_H);
      heatTmp      = new Float32Array(HEAT_W * HEAT_H);
      heatTexData  = new Float32Array(HEAT_W * HEAT_H);
      heatTex = new THREE.DataTexture(heatTexData, HEAT_W, HEAT_H, THREE.RedFormat, THREE.FloatType);
      heatTex.minFilter = heatTex.magFilter = THREE.LinearFilter;
      heatTex.needsUpdate = true;

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
      const bw = halfResBlur ? Math.ceil(width / 2) : width;
      const bh = halfResBlur ? Math.ceil(height / 2) : height;
      trailA = new THREE.WebGLRenderTarget(width, height, rtOpts);
      trailB = new THREE.WebGLRenderTarget(width, height, rtOpts);
      bloomA = new THREE.WebGLRenderTarget(bw, bh, rtOpts);
      bloomB = new THREE.WebGLRenderTarget(bw, bh, rtOpts);

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
          uClear:      { value: 0.0 },
          uRadiusX:    { value: brushRadius / resX },
          uRadiusY:    { value: brushRadius / resY },
          uTrailSoftX: { value: 0.0 },
          uTrailSoftY: { value: 0.0 },
          uFlow:       { value: flow },
          uVortex:     { value: vortex },
          uMirror:     { value: mirror ? 1.0 : 0.0 },
        },
        vertexShader,
        fragmentShader: accumFragmentShader,
        depthTest: false,
        depthWrite: false,
      });
      const accumMesh = new THREE.Mesh(accumGeometry, accumMaterial);
      accumMesh.frustumCulled = false;
      accumScene.add(accumMesh);

      blurScene = new THREE.Scene();
      blurGeometry = new THREE.PlaneGeometry(2, 2);
      blurMaterial = new THREE.ShaderMaterial({
        uniforms: {
          uTex: { value: blackTexture },
          uDir: { value: new THREE.Vector2() },
        },
        vertexShader,
        fragmentShader: blurFragmentShader,
        depthTest: false,
        depthWrite: false,
      });
      const blurMesh = new THREE.Mesh(blurGeometry, blurMaterial);
      blurMesh.frustumCulled = false;
      blurScene.add(blurMesh);

      compositeGeometry = new THREE.PlaneGeometry(2, 2);
      compositeMaterial = new THREE.ShaderMaterial({
        uniforms: {
          uTrail:      { value: trailA.texture },
          uBloomTex:   { value: blackTexture },
          uLiveFrame:  { value: blackTexture },
          uBlack:      { value: black },
          uThreshold:  { value: threshold },
          uGhost:      { value: ghostOpacity },
          uColorize:   { value: colorize },
          uColorsV2:   { value: colorC2.colorsV2 },
          uBrightness:     { value: colorShuffle.brightness },
          uBrightnessMult: { value: 1.0 },
          uPal0:       { value: new THREE.Vector3() },
          uPal1:       { value: new THREE.Vector3() },
          uPal2:       { value: new THREE.Vector3() },
          uBloom:      { value: bloom },
          uRgbSplit:   { value: rgbSplit },
          uMirror:     { value: mirror ? 1.0 : 0.0 },
          uKaleido:    { value: 0.0 },
          uKaleidoSeg: { value: kaleidoSeg },
          uHeatOffset:   { value: new THREE.Vector2(0, 0) },
          uHeatMap:      { value: heatTex },
          uHeatStrength: { value: 0 },
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
        if (privacyMode.active) { showOverlay(canvasRef, "Camera blocked by Sensor Block"); return; }
        startCamera(canvasRef);
      }
    },

    update(dt: number, _elapsed: number) {
      if (!_renderer || !accumMaterial || !compositeMaterial || !blurMaterial) return;

      if (privacyMode.active && cameraHandle) { stopCamera(); }

      const liveTex = cameraReady && videoTexture ? videoTexture : blackTexture!;
      if (cameraReady && videoTexture) videoTexture.needsUpdate = true;

      // Heat: reuse this instance's own live feed — only run the diff while the
      // toggle is on (the extra offscreen draw + readback isn't free).
      if (cameraState.heatEnabled && cameraReady && video && heatSmoothed && heatTmp && heatTexData && heatTex) {
        tickHeatDiff();
        for (let i = 0; i < HEAT_W * HEAT_H; i++)
          heatSmoothed[i] = heatSmoothed[i] * 0.82 + Math.max(0, heatRaw![i] - 0.008) * 0.18;
        heatBoxBlur(heatSmoothed, heatTmp, heatTexData, heatBlurR);
        heatTex.needsUpdate = true;
        const { cx, cy } = computeHeatCentroid();
        const tx = (0.5 - cx) * 0.35 * heatCenterStr;
        const ty = (0.5 - cy) * 0.35 * heatCenterStr;
        const spd = Math.min(1, dt * 2.5);
        heatOffset.x += (tx - heatOffset.x) * spd;
        heatOffset.y += (ty - heatOffset.y) * spd;
      } else {
        const decay = Math.max(0, 1 - dt * 3);
        heatOffset.x *= decay;
        heatOffset.y *= decay;
        heatPrevLuma = null; // re-warm the diff so a stale first frame isn't compared once re-enabled
      }
      compositeMaterial.uniforms.uHeatOffset.value.copy(heatOffset);
      compositeMaterial.uniforms.uHeatStrength.value = cameraState.heatEnabled ? heatStrength : 0;

      const doClear = clearRequested ? 1.0 : 0.0;
      clearRequested = false;

      const au = accumMaterial.uniforms;
      au.uTrail.value     = trailA!.texture;
      au.uLiveFrame.value = liveTex;
      au.uThreshold.value = threshold;
      au.uDecay.value     = decayRate;
      au.uGain.value      = gain;
      au.uClear.value     = doClear;
      au.uRadiusX.value   = brushRadius / resX;
      au.uRadiusY.value   = brushRadius / resY;
      au.uTrailSoftX.value = trailSoft / resX;
      au.uTrailSoftY.value = trailSoft / resY;
      au.uFlow.value      = flow;
      au.uVortex.value    = vortex * 0.05;
      au.uMirror.value    = mirror ? 1.0 : 0.0;

      _renderer.setRenderTarget(trailB);
      _renderer.render(accumScene!, accumCamera!);
      _renderer.setRenderTarget(null);

      [trailA, trailB] = [trailB!, trailA!];

      // Bloom: blur the fresh trail horizontally then vertically (skipped when off).
      let bloomTex: THREE.Texture = blackTexture!;
      if (bloom > 0 && bloomA && bloomB) {
        const spread = 2.0;
        const blurResX = halfResBlur ? resX / 2 : resX;
        const blurResY = halfResBlur ? resY / 2 : resY;
        blurMaterial.uniforms.uTex.value = trailA.texture;
        blurMaterial.uniforms.uDir.value.set(spread / blurResX, 0);
        _renderer.setRenderTarget(bloomA);
        _renderer.render(blurScene!, accumCamera!);

        blurMaterial.uniforms.uTex.value = bloomA.texture;
        blurMaterial.uniforms.uDir.value.set(0, spread / blurResY);
        _renderer.setRenderTarget(bloomB);
        _renderer.render(blurScene!, accumCamera!);
        _renderer.setRenderTarget(null);
        bloomTex = bloomB.texture;
      }

      const u = compositeMaterial.uniforms;
      u.uTrail.value      = trailA.texture;
      u.uBloomTex.value   = bloomTex;
      u.uLiveFrame.value  = liveTex;
      u.uBlack.value      = black;
      u.uThreshold.value  = threshold;
      u.uGhost.value      = ghostOpacity;
      u.uColorize.value   = colorize;
      u.uColorsV2.value   = colorC2.colorsV2;
      u.uBrightness.value     = colorShuffle.brightness;
      u.uBrightnessMult.value = interactionState.brightnessMult;
      u.uBloom.value      = bloom;
      u.uRgbSplit.value   = rgbSplit;
      u.uMirror.value     = mirror ? 1.0 : 0.0;
      u.uKaleido.value    = kaleidoOn ? 1.0 : 0.0;
      u.uKaleidoSeg.value = kaleidoSeg;
      // Palette ordered by the Color-Shuffle assignment (Apply Colors / Shuffle apply).
      const a = colorShuffle.assign;
      const p0 = new THREE.Color(getColorByIndex(a[0]));
      const p1 = new THREE.Color(getColorByIndex(a[1]));
      const p2 = new THREE.Color(getColorByIndex(a[2]));
      u.uPal0.value.set(p0.r, p0.g, p0.b);
      u.uPal1.value.set(p1.r, p1.g, p1.b);
      u.uPal2.value.set(p2.r, p2.g, p2.b);
    },

    resize(width: number, height: number) {
      resX = width;
      resY = height;
      trailA?.setSize(width, height);
      trailB?.setSize(width, height);
      const bw = halfResBlur ? Math.ceil(width / 2) : width;
      const bh = halfResBlur ? Math.ceil(height / 2) : height;
      bloomA?.setSize(bw, bh);
      bloomB?.setSize(bw, bh);
    },

    dispose() {
      stopCamera();
      blackTexture?.dispose();
      blackTexture = null;

      trailA?.dispose(); trailA = null;
      trailB?.dispose(); trailB = null;
      bloomA?.dispose(); bloomA = null;
      bloomB?.dispose(); bloomB = null;

      accumGeometry?.dispose(); accumGeometry = null;
      accumMaterial?.dispose(); accumMaterial = null;
      accumScene = null; accumCamera = null;

      blurGeometry?.dispose(); blurGeometry = null;
      blurMaterial?.dispose(); blurMaterial = null;
      blurScene = null;

      compositeGeometry?.dispose(); compositeGeometry = null;
      compositeMaterial?.dispose(); compositeMaterial = null;
      compositeMesh = null;

      heatTex?.dispose(); heatTex = null;
      heatDiffCanvas = null; heatDiffCtx = null;
      heatPrevLuma = null; heatLastVideoTime = -1;
      heatRaw = null; heatSmoothed = null; heatTmp = null; heatTexData = null;
      heatOffset.set(0, 0);

      overlay?.remove(); overlay = null;
      _renderer = null;
    },
  };
}

// ─── Preset tiles ─────────────────────────────────────────────────────────────
// Every preset exposes the identical full control set; only starting defaults
// differ, so any tile can be tuned into any other look.

export const lightPaint      = createLightPainting("lightPaint",      "Light Paint");
export const lightTrail      = createLightPainting("lightTrail",      "Light Trail",       { brushRadius: 0 });
export const lightPaintBlack = createLightPainting("lightPaintBlack", "Light Paint Black", { black: 1.0, ghostOpacity: 0 }, ["Black"]);
export const lightFly        = createLightPainting("lightFly",        "Light Fly",         { flow: -0.25 }, ["Fly In/Out"]);
export const lightVortex     = createLightPainting("lightVortex",     "Light Vortex",      { vortex: -0.10 }, ["Vortex"]);
export const lightKaleido    = createLightPainting("lightKaleido",    "Kaleidoscope",      { kaleidoOn: true, kaleidoSeg: 3, flow: 0.03 }, ["Kaleidoscope", "Segments"]);
export const lightGlitch     = createLightPainting("lightGlitch",     "RGB Glitch",        { rgbSplit: 0.020 }, ["RGB Split"]);
