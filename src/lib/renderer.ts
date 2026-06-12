import * as THREE from "three";
import type { Pattern, PatternContext } from "./patterns/types";
import { colorC2, colorShuffle, getColorByIndex } from "./colorC2.svelte";
import { interactionState } from "./interactionState.svelte";

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
  getCanvas: () => HTMLCanvasElement;
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
    current.resize(width, height);
  }

  function clearScene() {
    while (scene.children.length > 0) scene.remove(scene.children[0]);
  }

  function setPattern(next: Pattern) {
    current.dispose();
    clearScene();
    current = next;
    current.init(ctx);
    current.resize(size.width, size.height);
  }

  current.init(ctx);
  current.activate?.();

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
    const dt = (now - last) / 1000;
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
      // Drive blendK from the detected flashing area (set in processGuardSample):
      // ease down fast when flashing, recover slowly.
      const targetK = 1.0 - 0.82 * guardSeverity;       // 1.0 → 0.18 (strong damping when fully engaged)
      const rate = targetK < blendK ? 12 : 2;           // fast attack, slow release
      blendK += (targetK - blendK) * (1 - Math.exp(-dt * rate));
      guardReadout.blendK = Math.round(blendK * 100) / 100;

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
        processGuardSample(performance.now());
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

    raf = requestAnimationFrame(loop);
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
    getCanvas() { return canvas; },
    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("webglcontextlost", onContextLost as EventListener);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      ro.disconnect();
      current.dispose();
      clearScene();
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
