import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

// ─── Module state ─────────────────────────────────────────────────────────────
let renderer3: THREE.WebGLRenderer | null = null;

// Pass 1: internal Baroque Swirls render target
let swirlScene:   THREE.Scene | null = null;
let swirlCamera:  THREE.OrthographicCamera | null = null;
let swirlMesh:    THREE.Mesh | null = null;
let swirlGeo:     THREE.PlaneGeometry | null = null;
let swirlMat:     THREE.ShaderMaterial | null = null;
let swirlRT:      THREE.WebGLRenderTarget | null = null;

// Pass 2: ASCII display in the main scene
let asciiMesh: THREE.Mesh | null = null;
let asciiGeo:  THREE.PlaneGeometry | null = null;
let asciiMat:  THREE.ShaderMaterial | null = null;
let charTex:   THREE.CanvasTexture | null = null;

// Fallback 1×1 black texture used when camera is off
let blackTex: THREE.DataTexture | null = null;

// Camera mode state
let cameraMode  = false;
let camBlend    = 0.5;
let videoEl:    HTMLVideoElement | null = null;
let videoTex:   THREE.VideoTexture | null = null;
let camStream:  MediaStream | null = null;

// Controls
let signSize    = 8;   // px per character cell
let charSet     = 0;   // select: Dense / Sparse / Geometric / Letters
let colorMode   = 0;   // select: Source / Neon / Fire / Ice
let swirlSpeed  = 0.05;
let warpAmount  = 1.4;
let bandCount   = 13;

// Accumulated swirl time
let accTime = 0;
let viewWidth  = 1280;
let viewHeight =  720;

// ─── Character sets ───────────────────────────────────────────────────────────
const CHAR_SETS = [
  " .,-:;=+!*ioO0B#%@",          // Dense  (19 chars)
  " .,;-+coO0B@",                 // Sparse (12 chars)
  " .,;-+|/\\!?1iIlLoO0Xx#",     // Geometric (24 chars)
  " .,:;-+=!?*abcdeopqsuvwxyzABCDEFGHIJKLMNOPQRST0123456789#@", // Letters (60 chars)
];

// ─── Build character atlas texture ───────────────────────────────────────────
function buildCharAtlas(chars: string, cellW: number, cellH: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width  = chars.length * cellW;
  canvas.height = cellH;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${cellH - 1}px monospace`;
  ctx.textBaseline = "top";
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], i * cellW, 0);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// ─── Swirl (Baroque-style) shaders ───────────────────────────────────────────
const swirlVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const swirlFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2  uResolution;
  uniform float uBandCount;
  uniform float uWarpAmount;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
  }
  float fbm(vec2 p) {
    float v=0.0,a=0.5;
    for(int i=0;i<6;i++){v+=a*noise(p);p=p*2.1+vec2(3.1,1.7);a*=0.5;}
    return v;
  }
  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
    float t = uTime;
    vec2 q = vec2(fbm(p*1.3+t), fbm(p*1.3+vec2(5.2,1.3)-t*0.85));
    vec2 r = vec2(fbm(p*0.9+uWarpAmount*q+vec2(1.7,9.2)+t*0.6),
                  fbm(p*0.9+uWarpAmount*q+vec2(8.3,2.8)-t*0.4));
    float phi = fbm(p*0.65 + uWarpAmount*1.2*r);
    float band = fract(phi * uBandCount);
    float tealMask   = smoothstep(0.04,0.16,band)*smoothstep(0.46,0.34,band);
    float purpleMask = smoothstep(0.54,0.66,band)*smoothstep(0.96,0.84,band);
    float edge = smoothstep(0.44,0.48,band)*smoothstep(0.52,0.48,band)
               + smoothstep(0.94,0.97,band)*smoothstep(1.0,0.97,band)
               + smoothstep(0.0,0.03,band)*smoothstep(0.06,0.03,band);
    vec3 teal   = vec3(0.0,0.82,0.72)*0.75;
    vec3 purple = vec3(0.46,0.05,0.8)*0.80;
    vec3 dark   = vec3(0.0,0.0,0.03);
    vec3 col = dark + teal*tealMask + purple*purpleMask;
    col += vec3(0.85,0.95,0.9)*edge*0.18;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

// ─── ASCII display shader ─────────────────────────────────────────────────────
const asciiVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Color gradient helper: 3-stop ramp from lo→mid→hi via charMask
// Mode 0 Source: use srcCol directly
// Mode 1 Neon:   dark purple → cyan → near-white
// Mode 2 Fire:   black → deep orange → bright yellow
// Mode 3 Ice:    dark navy → teal → ice white
const asciiFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uSource;
  uniform sampler2D uCamera;
  uniform sampler2D uCharAtlas;
  uniform vec2  uResolution;
  uniform float uCellSize;
  uniform float uNumChars;
  uniform int   uColorMode;
  uniform float uCamBlend;

  vec3 gradRamp(float m, vec3 lo, vec3 mi, vec3 hi) {
    return m < 0.5 ? mix(lo, mi, m * 2.0) : mix(mi, hi, (m - 0.5) * 2.0);
  }

  void main() {
    vec2 cellCount  = floor(uResolution / uCellSize);
    vec2 cellId     = floor(vUv * cellCount);
    vec2 cellCenter = (cellId + 0.5) / cellCount;

    // Sample swirl and camera sources at cell center
    vec4 swirlSrc = texture2D(uSource, cellCenter);
    // Mirror camera horizontally (front-camera feel)
    vec4 camSrc   = texture2D(uCamera, vec2(1.0 - cellCenter.x, cellCenter.y));

    // Blend the two sources
    vec4 src  = mix(swirlSrc, camSrc, uCamBlend);
    float luma = dot(src.rgb, vec3(0.299, 0.587, 0.114));

    // Gamma expansion so full character range is used
    luma = pow(luma, 0.35);

    float ci = clamp(floor(luma * uNumChars), 0.0, uNumChars - 1.0);

    vec2 posInCell  = fract(vUv * cellCount);
    float atlasU    = (ci + posInCell.x) / uNumChars;
    float charMask  = texture2D(uCharAtlas, vec2(atlasU, posInCell.y)).r;

    vec3 col;
    if (uColorMode == 1) {
      // Neon: dark purple → cyan → near-white
      col = gradRamp(charMask,
        vec3(0.12, 0.0, 0.22),
        vec3(0.0,  0.9, 0.85),
        vec3(0.85, 1.0, 1.0)) * charMask;
    } else if (uColorMode == 2) {
      // Fire: near-black → deep orange → bright yellow
      col = gradRamp(charMask,
        vec3(0.05, 0.0, 0.0),
        vec3(0.9,  0.3, 0.0),
        vec3(1.0,  0.95,0.2)) * charMask;
    } else if (uColorMode == 3) {
      // Ice: dark navy → teal → ice white
      col = gradRamp(charMask,
        vec3(0.0,  0.05, 0.18),
        vec3(0.1,  0.75, 0.8),
        vec3(0.85, 0.97, 1.0)) * charMask;
    } else {
      // Source (mode 0)
      col = src.rgb * charMask;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function chars(): string { return CHAR_SETS[charSet]; }

function buildBlackTex(): THREE.DataTexture {
  const data = new Uint8Array([0, 0, 0, 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

function buildSwirlRT(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
}

function rebuildCharTex() {
  charTex?.dispose();
  charTex = buildCharAtlas(chars(), signSize, signSize);
  if (asciiMat) {
    asciiMat.uniforms.uCharAtlas.value = charTex;
    asciiMat.uniforms.uNumChars.value  = chars().length;
    asciiMat.uniforms.uCellSize.value  = signSize;
  }
}

function rebuildSwirlRT(w: number, h: number) {
  swirlRT?.dispose();
  swirlRT = buildSwirlRT(w, h);
  if (asciiMat) asciiMat.uniforms.uSource.value = swirlRT.texture;
}

async function enableAsciiCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    videoEl = document.createElement("video");
    videoEl.srcObject = camStream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    await videoEl.play();
    videoTex?.dispose();
    videoTex = new THREE.VideoTexture(videoEl);
    videoTex.minFilter = THREE.LinearFilter;
    videoTex.magFilter = THREE.LinearFilter;
    if (asciiMat) asciiMat.uniforms.uCamera.value = videoTex;
  } catch {
    cameraMode = false;
  }
}

function disableAsciiCamera() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  videoTex?.dispose();
  videoTex = null;
  if (videoEl) { videoEl.srcObject = null; videoEl = null; }
  if (asciiMat && blackTex) asciiMat.uniforms.uCamera.value = blackTex;
}

// ─── Pattern ─────────────────────────────────────────────────────────────────

export const asciiSwirls: Pattern = {
  id: "asciiSwirls",
  name: "ASCII Swirls",
  attribution: "ASCII rendering — source pattern: Baroque Swirls",
  controls: [
    { label: "Sign Size",   type: "range", min: 4, max: 32, step: 1, default: 8,
      get: () => signSize,
      set: (v) => { signSize = v; rebuildCharTex(); }
    },
    { label: "Char Set",    type: "select", options: ["Dense", "Sparse", "Geometric", "Letters"],
      get: () => charSet,
      set: (v) => { charSet = v; rebuildCharTex(); }
    },
    { label: "Color Mode",  type: "select", options: ["Source", "Neon", "Fire", "Ice"],
      get: () => colorMode, set: (v) => { colorMode = v; }
    },
    { label: "Swirl Speed", type: "range", min: 0.0, max: 0.3,  step: 0.005, default: 0.05, get: () => swirlSpeed, set: (v) => { swirlSpeed = v; } },
    { label: "Warp Amount", type: "range", min: 0.0, max: 3.0,  step: 0.05,  default: 1.4,  get: () => warpAmount, set: (v) => { warpAmount = v; } },
    { label: "Band Count",  type: "range", min: 2,   max: 20,   step: 1,     default: 13,   get: () => bandCount,  set: (v) => { bandCount = v; } },
    {
      label: "Camera Mode",
      type:  "section",
      get: () => cameraMode,
      set: (v) => {
        cameraMode = !!v;
        if (cameraMode) { enableAsciiCamera(); } else { disableAsciiCamera(); }
      },
    },
    {
      label: "Cam Blend",
      type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.5,
      disabled: () => !cameraMode,
      get: () => camBlend,
      set: (v) => { camBlend = v; },
    },
  ],

  init(ctx: PatternContext) {
    renderer3  = ctx.renderer;
    viewWidth  = ctx.size.width;
    viewHeight = ctx.size.height;

    blackTex = buildBlackTex();

    // ── Pass 1: Swirl scene ──
    swirlScene  = new THREE.Scene();
    swirlCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    swirlGeo    = new THREE.PlaneGeometry(2, 2);
    swirlMat    = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(viewWidth, viewHeight) },
        uBandCount:  { value: bandCount },
        uWarpAmount: { value: warpAmount },
      },
      vertexShader: swirlVert,
      fragmentShader: swirlFrag,
      depthTest: false, depthWrite: false,
    });
    swirlMesh = new THREE.Mesh(swirlGeo, swirlMat);
    swirlMesh.frustumCulled = false;
    swirlScene.add(swirlMesh);

    swirlRT = buildSwirlRT(viewWidth, viewHeight);

    // ── Character atlas ──
    charTex = buildCharAtlas(chars(), signSize, signSize);

    // ── Pass 2: ASCII display in main scene ──
    asciiGeo = new THREE.PlaneGeometry(2, 2);
    asciiMat = new THREE.ShaderMaterial({
      uniforms: {
        uSource:     { value: swirlRT.texture },
        uCamera:     { value: blackTex },
        uCharAtlas:  { value: charTex },
        uResolution: { value: new THREE.Vector2(viewWidth, viewHeight) },
        uCellSize:   { value: signSize },
        uNumChars:   { value: chars().length },
        uColorMode:  { value: colorMode },
        uCamBlend:   { value: 0.0 },
      },
      vertexShader: asciiVert,
      fragmentShader: asciiFrag,
      depthTest: false, depthWrite: false,
    });
    asciiMesh = new THREE.Mesh(asciiGeo, asciiMat);
    asciiMesh.frustumCulled = false;
    ctx.scene.add(asciiMesh);

    // Park camera so the fullscreen quad fills the view
    ctx.camera.position.set(0, 0, 1);
    ctx.camera.near = 0.01;
    ctx.camera.far  = 10;
    ctx.camera.updateProjectionMatrix();

    if (cameraMode) enableAsciiCamera();
  },

  update(dt: number, _elapsed: number) {
    if (!renderer3 || !swirlScene || !swirlCamera || !swirlRT || !swirlMat || !asciiMat) return;

    accTime += dt * swirlSpeed;
    swirlMat.uniforms.uTime.value       = accTime;
    swirlMat.uniforms.uBandCount.value  = bandCount;
    swirlMat.uniforms.uWarpAmount.value = warpAmount;
    asciiMat.uniforms.uColorMode.value  = colorMode;
    asciiMat.uniforms.uCamBlend.value   = cameraMode && videoTex ? camBlend : 0.0;

    if (videoTex) videoTex.needsUpdate = true;

    // Render swirl into the RT
    const prev = renderer3.getRenderTarget();
    renderer3.setRenderTarget(swirlRT);
    renderer3.render(swirlScene, swirlCamera);
    renderer3.setRenderTarget(prev);
  },

  resize(width: number, height: number) {
    viewWidth  = width;
    viewHeight = height;
    if (swirlMat) swirlMat.uniforms.uResolution.value.set(width, height);
    if (asciiMat) asciiMat.uniforms.uResolution.value.set(width, height);
    rebuildSwirlRT(width, height);
  },

  dispose() {
    disableAsciiCamera();
    swirlGeo?.dispose(); swirlMat?.dispose();
    swirlScene = null; swirlCamera = null; swirlMesh = null;
    swirlGeo = null; swirlMat = null;
    swirlRT?.dispose(); swirlRT = null;
    asciiGeo?.dispose(); asciiMat?.dispose();
    asciiMesh = null; asciiGeo = null; asciiMat = null;
    charTex?.dispose(); charTex = null;
    blackTex?.dispose(); blackTex = null;
    renderer3 = null;
    accTime = 0;
  },
};
