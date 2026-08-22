import * as THREE from "three";
import type { Pattern, PatternContext } from "./patterns/types";
import { colorC2, colorShuffle, getColorByIndex } from "./colorC2.svelte";
import { interactionState } from "./interactionState.svelte";
import { keepCameraAlive } from "./motionCameraWrapper";
import { overlayState } from "./textOverlay.svelte";
import { watermarkState } from "./watermark.svelte";
import { getWatermarkTexture, disposeWatermarkTexture } from "./watermarkTexture";
import {
  loadFont, getFont, buildTextGroup as buildOverlayGroup, disposeTextGroup,
  applyTextOpacity, applyTextColors, cycleAlpha,
} from "./overlayText";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface RendererHandle {
  setPattern: (next: Pattern) => void;
  activateCurrentPattern: () => void;
  setTimeScale: (v: number) => void;
  getTimeScale: () => number;
  setFlickerGuard: (enabled: boolean) => void;
  /** Briefly suspend flicker-guard detection and damping (ms, capped at 3 s).
   *  For intentional whole-frame transitions — randomize sweeps, preset restores,
   *  pattern switches — whose abrupt luminance change would otherwise trip the
   *  guard and dim thin-feature patterns to near-black. Steady-state protection
   *  is untouched; detection restarts cleanly when the window ends. */
  suppressGuard: (ms: number) => void;
  /** Current flicker-guard blend factor: 1 = passthrough, <1 = actively damping.
   *  Lets the HUD show WHY the image is dimming (guard engaged) instead of it
   *  reading as a rendering bug. */
  getGuardBlendK: () => number;
  getCanvas: () => HTMLCanvasElement;
  /** Timestamp (performance.now()) of the last loop() invocation, whether or not that
   *  frame's render succeeded — a watchdog can use staleness here to detect a dead
   *  RAF loop (uncaught frame error, or WebGL context loss that never restores). */
  getLastFrameAt: () => number;
  dispose: () => void;
}

const postVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const postFragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform vec3  uHaupt;
  uniform vec3  uKontrast;
  uniform vec3  uGlow;
  uniform float uSaturation;
  uniform float uBrightness;
  uniform float uColorEnabled;
  uniform sampler2D uPrev;   // previously displayed frame (flicker guard)
  uniform float uBlendK;     // 1 = no smoothing; <1 = blend toward uPrev to damp flicker
  varying vec2 vUv;

  vec3 rgb2hsl(vec3 c) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float l  = (mx + mn) * 0.5;
    float d  = mx - mn;
    if (d < 0.0001) return vec3(0.0, 0.0, l);
    float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    float h;
    if      (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else                h = (c.r - c.g) / d + 4.0;
    return vec3(h / 6.0, s, l);
  }

  float hue2rgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
    if (t < 1.0/2.0) return q;
    if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
    return p;
  }

  vec3 hsl2rgb(vec3 c) {
    if (c.y < 0.0001) return vec3(c.z);
    float q = c.z < 0.5 ? c.z * (1.0 + c.y) : c.z + c.y - c.z * c.y;
    float p = 2.0 * c.z - q;
    return vec3(hue2rgb(p, q, c.x + 1.0/3.0),
                hue2rgb(p, q, c.x),
                hue2rgb(p, q, c.x - 1.0/3.0));
  }

  void main() {
    vec3 col = texture2D(uScene, vUv).rgb;

    // ── Hue warp (only when Apply Colors is on) ──────────────────────────────
    if (uColorEnabled > 0.5) {
      vec3  hsl  = rgb2hsl(col);
      float h = hsl.x, s = hsl.y, l = hsl.z;

      // Map source arc [0.50 cyan → 0.83 magenta] to [uHaupt → uKontrast]
      float srcSpan = 0.33;
      float pos     = fract(h - 0.5 + 1.0);
      float t       = clamp(pos / srcSpan, 0.0, 1.0);

      vec3  hslA = rgb2hsl(uHaupt);
      vec3  hslB = rgb2hsl(uKontrast);
      float diff = hslB.x - hslA.x;
      if (diff >  0.5) diff -= 1.0;
      if (diff < -0.5) diff += 1.0;
      float mappedHue = fract(hslA.x + diff * t);

      vec3 remapped = hsl2rgb(vec3(mappedHue, s, l));

      // Blend brightest pixels toward Glow colour
      float glowW = smoothstep(0.75, 1.0, l);
      remapped = mix(remapped, uGlow, glowW * 0.75);

      col = remapped;
    }

    // ── Saturation ───────────────────────────────────────────────────────────
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, uSaturation);

    // ── Brightness ───────────────────────────────────────────────────────────
    col = clamp(col * uBrightness, 0.0, 1.0);

    // ── Flicker guard: temporal blend toward previous frame ────────────────────
    // uBlendK == 1 → output is the current frame unchanged (no smoothing, no trails).
    // When the guard detects flashing it lowers uBlendK, low-passing the image over
    // time so high-frequency luminance swings (incl. moving gratings) are damped.
    if (uBlendK < 0.999) {
      vec3 prev = texture2D(uPrev, vUv).rgb;
      col = mix(prev, col, uBlendK);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

// Minimal copy/downsample shader: samples a texture and writes it out unchanged.
// Used to blit the blended history target to the canvas and to downsample it into
// the tiny analysis target.
const copyFragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(texture2D(uTex, vUv).rgb, 1.0); }
`;

export function createRenderer(canvas: HTMLCanvasElement, initial: Pattern): RendererHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 0, 5);

  let size = { width: 1, height: 1 };
  let current: Pattern = initial;
  let timeScale = 1.0;

  const ctx: PatternContext = { scene, camera, renderer, size };

  // ── Text overlay ───────────────────────────────────────────────────────────
  // Drawn after the post pass, in its own scene with its own camera, so the text
  // is neither colour-graded nor damped by the flicker guard and is immune to
  // whatever the active pattern does with the shared camera. It lives here rather
  // than in a pattern because setPattern() wipes the shared scene on every switch.
  const overlayScene = new THREE.Scene();
  const overlayCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  overlayCamera.position.set(0, 0, 5);
  overlayCamera.lookAt(0, 0, 0);
  let overlayGroup: THREE.Group | null = null;
  let overlayPhase = 0;
  let overlaySpinYaw = 0;
  let overlayFontRequested = false;
  // Rebuild only when something that changes the geometry changes.
  let overlayKey = "";

  // ── Watermark ──────────────────────────────────────────────────────────────
  // Lives in the same overlay scene and camera as the text, so it inherits the same
  // immunity from the colour grade and flicker guard, and the same presence in
  // screenshots and recordings.
  let markMesh: THREE.Mesh | null = null;
  let markMat: THREE.MeshBasicMaterial | null = null;
  let markGeo: THREE.PlaneGeometry | null = null;

  function disposeWatermark() {
    if (markMesh) overlayScene.remove(markMesh);
    markGeo?.dispose();
    markMat?.dispose();
    disposeWatermarkTexture();
    markMesh = null; markMat = null; markGeo = null;
  }

  function renderWatermarkUpdate() {
    if (!watermarkState.enabled || !watermarkState.dataUrl) {
      if (markMesh) { overlayScene.remove(markMesh); markMesh.visible = false; }
      return;
    }
    const tex = getWatermarkTexture(watermarkState.dataUrl);
    if (!tex) return;

    if (!markMesh) {
      markGeo = new THREE.PlaneGeometry(1, 1);
      markMat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
      markMesh = new THREE.Mesh(markGeo, markMat);
      markMesh.renderOrder = 10;  // always on top of the text
    }
    if (markMesh.parent !== overlayScene) overlayScene.add(markMesh);
    markMesh.visible = true;
    markMat!.map = tex;
    markMat!.opacity = watermarkState.opacity;
    markMat!.needsUpdate = true;

    // Same frustum math the text position uses, so -1..1 means the same thing here.
    const halfH = Math.tan((overlayCamera.fov * Math.PI / 180) / 2) * overlayCamera.position.z;
    const halfW = halfH * overlayCamera.aspect;
    const w = watermarkState.scale * halfW * 2;
    const h = w / Math.max(0.01, watermarkState.aspect);
    markMesh.scale.set(w, h, 1);

    // Pin to a corner, then inset by the margin plus half the image so the whole
    // thing sits inside the frame rather than straddling the edge.
    const m = watermarkState.margin * halfH;
    const x = halfW - m - w / 2;
    const y = halfH - m - h / 2;
    switch (watermarkState.anchor) {
      case 0: markMesh.position.set(-x,  y, 0); break;  // top left
      case 1: markMesh.position.set( x,  y, 0); break;  // top right
      case 2: markMesh.position.set(-x, -y, 0); break;  // bottom left
      case 4: markMesh.position.set( 0,  0, 0); break;  // centre
      default: markMesh.position.set(x, -y, 0);         // bottom right
    }
  }

  function overlayColors(): { primary: string; glow: string } {
    const ph1 = Math.min(1.0, colorC2.colorsV2);
    const ph2 = Math.max(0, colorC2.colorsV2 - 1) / 2;
    const p = new THREE.Color().lerpColors(new THREE.Color(1, 1, 1), new THREE.Color(colorC2.main), ph1);
    const g = new THREE.Color().lerpColors(p, new THREE.Color(colorC2.contrast), ph2);
    return { primary: '#' + p.getHexString(), glow: '#' + g.getHexString() };
  }

  function disposeOverlay() {
    if (!overlayGroup) return;
    disposeTextGroup(overlayGroup);
    overlayScene.remove(overlayGroup);
    overlayGroup = null;
    overlayKey = "";
  }

  /** Brings the text group up to date. Returns false if there is nothing to draw. */
  function updateOverlayText(dt: number): boolean {
    if (!overlayState.enabled) {
      if (overlayGroup) disposeOverlay();
      return false;
    }
    if (!getFont()) {
      if (!overlayFontRequested) {
        overlayFontRequested = true;
        loadFont().catch(err => console.error('[overlay] font load failed:', err));
      }
      return false;
    }

    const c = overlayColors();
    // Colour is deliberately NOT in the key. It is a material property, and under
    // Motion the palette shifts every frame — keying on it re-tessellated the whole
    // text sixty times a second. Geometry inputs only.
    const key = [overlayState.text, overlayState.size, overlayState.depth, overlayState.style,
                 overlayState.mode, overlayState.align, overlayState.lineSpacing,
                 (overlayState.lineSizes ?? []).join(',')].join('|');
    if (key !== overlayKey) {
      // Build first, swap only on success — a degenerate geometry must not blank the text.
      let next: THREE.Group;
      try {
        next = buildOverlayGroup({
          text: overlayState.text, size: overlayState.size, depth: overlayState.depth,
          style: overlayState.style, align: overlayState.align,
          lineSpacing: overlayState.lineSpacing, lineSizes: overlayState.lineSizes,
          flat: overlayState.mode === 1,
          primaryColor: c.primary, glowColor: c.glow,
        });
      } catch (err) {
        console.error('[overlay] build failed — keeping previous text', err);
        overlayKey = key; // don't retry the same broken input every frame
        return false;
      }
      if (overlayGroup) { disposeTextGroup(overlayGroup); overlayScene.remove(overlayGroup); }
      overlayScene.add(next);
      overlayGroup = next;
      overlayKey = key;
    }
    if (!overlayGroup) return false;

    // Repaint from the palette every frame — cheap, and what lets the key above
    // ignore colour entirely.
    applyTextColors(overlayGroup, c.primary, c.glow);

    // Simple mode faces front and holds there.
    if (overlayState.mode === 1) {
      overlaySpinYaw = 0;
    } else {
      overlaySpinYaw += dt * overlayState.spin;
    }
    overlayGroup.rotation.y = overlaySpinYaw;
    // posX/posY are -1..1 of the half-view, so the text can be parked anywhere.
    const halfH = Math.tan((overlayCamera.fov * Math.PI / 180) / 2) * overlayCamera.position.z;
    overlayGroup.position.set(overlayState.posX * halfH * overlayCamera.aspect, overlayState.posY * halfH, 0);

    let alpha = overlayState.opacity;
    if (overlayState.cycle) {
      overlayPhase += dt;
      alpha *= cycleAlpha(overlayPhase, overlayState.showFor, overlayState.hideFor);
    } else if (overlayPhase !== 0) {
      overlayPhase = 0;
    }
    applyTextOpacity(overlayGroup, alpha);
    return overlayGroup.visible;
  }

  /**
   * One pass for text and watermark together. Either can be on without the other,
   * so the draw is decided here rather than by whichever one happens to run first.
   */
  function renderOverlay(dt: number) {
    const textVisible = updateOverlayText(dt);
    if (overlayGroup) overlayGroup.visible = textVisible;
    renderWatermarkUpdate();
    const markVisible = !!markMesh?.visible;
    if (!textVisible && !markVisible) return;

    // autoClear would wipe the frame the post pass just composited.
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(overlayScene, overlayCamera);
    renderer.autoClear = prevAutoClear;
  }

  // ── Post-process pass (MSAA render target for smoother lines) ─────────────
  let rt = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    samples: 4,  // 4× MSAA — requires WebGL2 (gracefully ignored on WebGL1)
  });

  const postUniforms = {
    uScene:        { value: rt.texture },
    uHaupt:        { value: new THREE.Vector3(...hexToRgb(colorC2.main)) },
    uKontrast:     { value: new THREE.Vector3(...hexToRgb(colorC2.contrast)) },
    uGlow:         { value: new THREE.Vector3(...hexToRgb(colorC2.glow)) },
    uSaturation:   { value: colorShuffle.saturation },
    uBrightness:   { value: colorShuffle.brightness },
    uColorEnabled: { value: colorShuffle.enabled ? 1.0 : 0.0 },
    uPrev:         { value: rt.texture }, // harmless default; re-pointed when guard active
    uBlendK:       { value: 1.0 },
  };

  const postMaterial = new THREE.ShaderMaterial({
    uniforms: postUniforms,
    vertexShader: postVertexShader,
    fragmentShader: postFragmentShader,
    depthTest: false,
    depthWrite: false,
  });

  const postScene  = new THREE.Scene();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postQuad   = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial);
  postScene.add(postQuad);

  // ── Flicker-guard resources (only used when flickerGuard.enabled) ──────────
  // Two full-res history targets ping-pong to hold the previously displayed frame
  // for temporal blending; a copy shader blits the blended frame to the canvas and
  // downsamples it into a tiny target whose pixels are read back asynchronously.
  const makeHistRT = (w: number, h: number) => new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
  });
  let histA = makeHistRT(1, 1);
  let histB = makeHistRT(1, 1);
  let histPrev = histA; // holds last displayed frame
  let histCur  = histB; // target we render the current blended frame into

  const GUARD_W = 64, GUARD_H = 36;
  const guardRT = new THREE.WebGLRenderTarget(GUARD_W, GUARD_H, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
  });
  const guardBuf = new Uint8Array(GUARD_W * GUARD_H * 4);

  const copyUniforms = { uTex: { value: rt.texture as THREE.Texture } };
  const copyMaterial = new THREE.ShaderMaterial({
    uniforms: copyUniforms, vertexShader: postVertexShader, fragmentShader: copyFragmentShader,
    depthTest: false, depthWrite: false,
  });
  const copyQuad  = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copyMaterial);
  const copyScene = new THREE.Scene();
  copyScene.add(copyQuad);

  // Detection state (CPU side) — per-cell so moving high-contrast gratings (where
  // the whole-frame mean luminance barely changes, e.g. the Tunnel) are still caught,
  // and so we can estimate the *flashing area* the way ITU-R BT.1702 does.
  const CELLS = GUARD_W * GUARD_H;
  let guardEnabled = true;                    // pushed in via handle.setFlickerGuard()
  // Live read-out (dev-only window hook below) for debugging/verification.
  const guardReadout = { flashesPerSec: 0, blendK: 1, area: 0 };
  let guardTick = 0;
  const GUARD_EVERY = 2;                      // sample every Nth frame (bounds readback cost)
  let blendK = 1.0;                          // current eased blend factor
  let guardSeverity = 0;                     // 0..1, drives blendK (from flashing area)
  let lastSampleT = 0;                       // ms of previous processed sample
  const cellPrev = new Float32Array(CELLS);  // last luminance per cell
  const cellExtremum = new Float32Array(CELLS);
  const cellDir = new Int8Array(CELLS);      // +1 rising / -1 falling / 0 unknown
  const cellRate = new Float32Array(CELLS);  // decaying count of opposing transitions (~ per last 1 s)
  const FLASH_DELTA = 0.10;                  // min luminance swing to count a transition
  const DECAY_TAU = 1.0;                     // s — memory of the transition-rate estimate
  const CELL_FLASH_TRANS = 6;               // transitions/s (= 3 flash pairs/s) → cell "flashing"
  const AREA_LOW = 0.10, AREA_HIGH = 0.30;   // engage from 10% area, full damping at 30%
  let guardSuppressUntil = 0;                // performance.now() deadline of an intentional-transition window

  function suppressGuard(ms: number) {
    guardSuppressUntil = performance.now() + Math.min(Math.max(0, ms), 3000);
    // Forget accumulated flash history so the transition itself is never counted
    // and stale pre-transition rates can't re-engage damping afterwards.
    cellRate.fill(0); cellDir.fill(0); cellExtremum.fill(0); cellPrev.fill(0);
    guardSeverity = 0;
    blendK = 1;
    lastSampleT = 0; // first post-suppression sample warms up with dtS = 0
    guardReadout.blendK = 1; guardReadout.flashesPerSec = 0; guardReadout.area = 0;
  }

  function processGuardSample(now: number) {
    const dtS = lastSampleT ? Math.min(0.5, (now - lastSampleT) / 1000) : 0;
    lastSampleT = now;
    const decay = Math.exp(-dtS / DECAY_TAU);

    let flashingCells = 0;
    let maxRate = 0;
    for (let c = 0; c < CELLS; c++) {
      const o = c * 4;
      const lum = (0.2126 * guardBuf[o] + 0.7152 * guardBuf[o + 1] + 0.0722 * guardBuf[o + 2]) / 255;
      cellRate[c] *= decay;
      const prev = cellPrev[c];
      const dir = lum > prev ? 1 : lum < prev ? -1 : cellDir[c];
      if (cellDir[c] !== 0 && dir !== 0 && dir !== cellDir[c]) {
        // Direction reversed: `prev` is the turning point (local peak/trough). The
        // half-cycle swing is from the previous extremum to this turning point.
        // Count it if the swing is real and the darker level is below 0.8× the
        // brighter (ITU-style contrast gate).
        const swing = Math.abs(prev - cellExtremum[c]);
        const darker = Math.min(prev, cellExtremum[c]);
        const brighter = Math.max(prev, cellExtremum[c]);
        if (swing >= FLASH_DELTA && darker < 0.8 * brighter + 0.0001) cellRate[c] += 1;
        cellExtremum[c] = prev;
      }
      if (dir !== 0) cellDir[c] = dir;
      cellPrev[c] = lum;

      if (cellRate[c] >= CELL_FLASH_TRANS) flashingCells++;
      if (cellRate[c] > maxRate) maxRate = cellRate[c];
    }

    const flashArea = flashingCells / CELLS;
    guardSeverity = Math.max(0, Math.min(1, (flashArea - AREA_LOW) / (AREA_HIGH - AREA_LOW)));
    guardReadout.flashesPerSec = Math.round((maxRate / 2) * 10) / 10;
    guardReadout.area = Math.round(flashArea * 100) / 100;
  }
  // ──────────────────────────────────────────────────────────────────────────

  function applySize(width: number, height: number) {
    size.width = width;
    size.height = height;
    renderer.setSize(width, height, false);
    rt.setSize(width, height);
    histA.setSize(width, height);
    histB.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    overlayCamera.aspect = camera.aspect;
    overlayCamera.updateProjectionMatrix();
    current.resize(width, height);
  }

  function clearScene() {
    while (scene.children.length > 0) scene.remove(scene.children[0]);
  }

  function setPattern(next: Pattern) {
    // Only skip the motion camera's teardown if the incoming pattern will actually
    // reuse it (avoids a black-screen restart between two camera-reactive patterns).
    // If the incoming pattern doesn't use the motion wrapper (e.g. Light Painting,
    // ASCII Swirls), let dispose() stop the outgoing pattern's camera normally —
    // otherwise it leaks as an unmanaged stream nobody ticks or stops.
    const reuseCamera = !!next.motionReactive;
    // A pattern switch is an intentional whole-frame change — don't let the
    // flicker guard read it (or stale history from the old pattern) as flashing.
    suppressGuard(1300);
    if (reuseCamera) keepCameraAlive(true);
    current.dispose();
    clearScene();
    current = next;
    current.init(ctx);
    if (reuseCamera) keepCameraAlive(false);
    current.resize(size.width, size.height);
  }

  current.init(ctx);
  // Do NOT call current.activate?.() here — the initial pattern loads into the
  // overview grid (preview only). Real activation happens explicitly via
  // activateCurrentPattern() when the user picks a pattern, so a camera-driven
  // pattern (e.g. Hyper Mix Heat, patterns[0]) doesn't grab the camera on app load.

  const ro = new ResizeObserver((entries) => {
    const rect = entries[0].contentRect;
    applySize(Math.max(1, rect.width), Math.max(1, rect.height));
  });
  ro.observe(canvas);

  const initialRect = canvas.getBoundingClientRect();
  applySize(Math.max(1, initialRect.width), Math.max(1, initialRect.height));

  let raf = 0;
  let last = performance.now();
  const start = last;
  let lastFrameAt = last;

  // ── WebGL context loss/restore ────────────────────────────────────────────
  // Mobile GPUs (notably low/mid-end Android) drop the GL context under memory
  // pressure or when backgrounding the tab. Without handling, the canvas goes
  // black and never recovers. preventDefault() on the lost event tells the
  // browser a restore is wanted; on restore we rebuild GPU-side resources.
  let contextLost = false;

  function onContextLost(e: Event) {
    e.preventDefault();
    contextLost = true;
    cancelAnimationFrame(raf);
  }

  function onContextRestored() {
    if (!contextLost) return;
    contextLost = false;
    // The old render target's GPU texture is gone — recreate it and re-point
    // the post pass at the new texture.
    rt.dispose();
    rt = new THREE.WebGLRenderTarget(Math.max(1, size.width), Math.max(1, size.height), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      samples: 4,
    });
    postUniforms.uScene.value = rt.texture;
    // Flicker-guard history targets are also gone — recreate them.
    histA.dispose();
    histB.dispose();
    histA = makeHistRT(Math.max(1, size.width), Math.max(1, size.height));
    histB = makeHistRT(Math.max(1, size.width), Math.max(1, size.height));
    histPrev = histA;
    histCur  = histB;
    // Rebuild the active pattern's GPU resources from scratch.
    current.dispose();
    clearScene();
    current.init(ctx);
    current.resize(size.width, size.height);
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }

  canvas.addEventListener("webglcontextlost", onContextLost as EventListener, false);
  canvas.addEventListener("webglcontextrestored", onContextRestored, false);

  function loop(now: number) {
    lastFrameAt = now; // heartbeat — the loop is alive even if this frame's render throws below
    try {
      renderFrame(now);
    } catch (err) {
      console.error('[renderer] frame error — skipping this frame', err);
    }
    raf = requestAnimationFrame(loop);
  }

  function renderFrame(now: number) {
    // Cap dt so a genuine stall (GC pause, tab-switch, a slow synchronous
    // repaint) can't inflate the NEXT frame's motion step into a visible
    // jump — 1/20s is well above normal frame-time variance (never clips an
    // ordinary dip to ~24fps), so this only engages for real stalls.
    const RAW_DT_MAX = 1 / 20;
    const dt = Math.min((now - last) / 1000, RAW_DT_MAX);
    const elapsed = (now - start) / 1000;
    last = now;
    // Tier 1: Speed universal — driven by motionCameraWrapper per active pattern.
    // speedMult > 1 when motion is active; < 1 during prolonged stillness.
    // Falls back to 1.0 when no motion camera is running.
    current.update(dt * timeScale * interactionState.speedMult, elapsed);

    // Sync per-pattern colour assignment into post-process uniforms
    const [a0, a1, a2] = colorShuffle.assign;
    const [hR, hG, hB] = hexToRgb(getColorByIndex(a0));
    postUniforms.uHaupt.value.set(hR, hG, hB);
    const [kR, kG, kB] = hexToRgb(getColorByIndex(a1));
    postUniforms.uKontrast.value.set(kR, kG, kB);
    const [gR, gG, gB] = hexToRgb(getColorByIndex(a2));
    postUniforms.uGlow.value.set(gR, gG, gB);
    postUniforms.uSaturation.value   = colorShuffle.saturation;
    // Apply universal Brightness multiplier from audio on top of per-pattern brightness
    postUniforms.uBrightness.value   = colorShuffle.brightness * interactionState.brightnessMult;
    postUniforms.uColorEnabled.value = colorShuffle.enabled ? 1.0 : 0.0;

    // Scene → RT (MSAA) for both paths
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);

    if (guardEnabled) {
      // ── Guarded path: blend with previous frame, blit to canvas, analyse ──────
      // During an intentional-transition window (suppressGuard) hold blendK at 1
      // and skip sampling; the history blit below keeps running so histPrev is
      // fresh the moment the window ends.
      const suppressed = now < guardSuppressUntil;
      if (suppressed) {
        blendK = 1.0;
        guardReadout.blendK = 1;
      } else {
        // Drive blendK from the detected flashing area (set in processGuardSample):
        // ease down fast when flashing, recover slowly.
        const targetK = 1.0 - 0.82 * guardSeverity;       // 1.0 → 0.18 (strong damping when fully engaged)
        const rate = targetK < blendK ? 12 : 2;           // fast attack, slow release
        blendK += (targetK - blendK) * (1 - Math.exp(-dt * rate));
        guardReadout.blendK = Math.round(blendK * 100) / 100;
      }

      // Post(rt, prev) → histCur  (temporal blend happens in the post shader)
      postUniforms.uPrev.value   = histPrev.texture;
      postUniforms.uBlendK.value = blendK;
      renderer.setRenderTarget(histCur);
      renderer.render(postScene, postCamera);

      // Blit histCur → canvas
      copyUniforms.uTex.value = histCur.texture;
      renderer.setRenderTarget(null);
      renderer.render(copyScene, postCamera);

      // Downsample histCur → tiny guardRT and read it back. The target is tiny
      // (≈GUARD_W×GUARD_H px) so the synchronous read is cheap; only run it every
      // few frames to bound the GPU-sync cost.
      guardTick++;
      if (guardTick % GUARD_EVERY === 0) {
        renderer.setRenderTarget(guardRT);
        renderer.render(copyScene, postCamera);
        renderer.readRenderTargetPixels(guardRT, 0, 0, GUARD_W, GUARD_H, guardBuf);
        renderer.setRenderTarget(null);
        // During an intentional-transition window the sample is discarded —
        // keeping the readback itself running keeps GPU timing identical.
        if (!suppressed) processGuardSample(performance.now());
      }

      // Swap history ping-pong: this frame becomes next frame's "previous"
      histPrev = histCur;
      histCur  = (histCur === histA) ? histB : histA;
    } else {
      // ── Unguarded path: identical to original (post → canvas) ─────────────────
      postUniforms.uBlendK.value = 1.0;
      blendK = 1.0;
      guardSeverity = 0;
      lastSampleT = 0;        // restart detection cleanly if re-enabled
      guardReadout.blendK = 1;
      guardReadout.flashesPerSec = 0;
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCamera);
    }

    // Text overlay last, straight onto the canvas, so it escapes the colour grade
    // and the flicker guard and lands in screenshots and recordings.
    renderOverlay(dt);
  }
  raf = requestAnimationFrame(loop);

  // Dev-only: expose the guard read-out for debugging/verification.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as { __flickerGuard: typeof guardReadout }).__flickerGuard = guardReadout;
  }

  return {
    setPattern,
    activateCurrentPattern() { current.activate?.(); },
    setTimeScale(v: number) { timeScale = Math.max(0, v); },
    getTimeScale() { return timeScale; },
    setFlickerGuard(enabled: boolean) { guardEnabled = enabled; },
    suppressGuard,
    getGuardBlendK() { return blendK; },
    getCanvas() { return canvas; },
    getLastFrameAt() { return lastFrameAt; },
    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("webglcontextlost", onContextLost as EventListener);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      ro.disconnect();
      current.dispose();
      clearScene();
      disposeOverlay();
      disposeWatermark();
      renderer.dispose();
      rt.dispose();
      histA.dispose();
      histB.dispose();
      guardRT.dispose();
      postMaterial.dispose();
      copyMaterial.dispose();
    },
  };
}
