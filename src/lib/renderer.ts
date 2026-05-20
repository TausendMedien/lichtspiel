import * as THREE from "three";
import type { Pattern, PatternContext } from "./patterns/types";
import { colorC2 } from "./colorC2.svelte";

// ── Palette hue helpers ────────────────────────────────────────────────────────
const PALETTE_KEYS  = ['cyan','magenta','purple','gold','white','black'];
const PALETTE_DEFS  = ['#00ffff','#ff00ff','#9900ff','#ffd700','#ffffff','#000000'];

function hexToHue(hex: string): number {
  const n = parseInt(hex.replace('#',''), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >>  8) & 255) / 255;
  const b = ( n        & 255) / 255;
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx - mn;
  if (d < 0.0001) return 0;
  let h = 0;
  if      (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else               h = (r - g) / d + 4;
  return h / 6;
}

function loadPaletteHues(): number[] {
  try {
    const stored = localStorage.getItem('pp:palette');
    const obj = stored ? (JSON.parse(stored) as Record<string,string>) : {};
    return PALETTE_KEYS.map((k, i) => hexToHue(obj[k] ?? PALETTE_DEFS[i]));
  } catch { return PALETTE_DEFS.map(hexToHue); }
}

export interface RendererHandle {
  setPattern: (next: Pattern) => void;
  activateCurrentPattern: () => void;
  setTimeScale: (v: number) => void;
  getTimeScale: () => number;
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
  uniform float uHue;
  uniform float uSaturation;
  uniform float uBrightness;
  uniform float uPaletteHues[6];
  varying vec2 vUv;

  vec3 rgb2hsl(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float l = (maxC + minC) * 0.5;
    float d = maxC - minC;
    if (d < 0.0001) return vec3(0.0, 0.0, l);
    float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
    float h;
    if (maxC == c.r)      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
    else                  h = (c.r - c.g) / d + 4.0;
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

  // Interpolate across the 6 palette hue stops (0..1 input → hue 0..1 output)
  float palHueAt(float t) {
    float s  = clamp(t, 0.0, 1.0) * 5.0;
    int   lo = int(s);
    int   hi = min(lo + 1, 5);
    float f  = fract(s);
    float h0 = uPaletteHues[lo];
    float h1 = uPaletteHues[hi];
    // Shortest path around the hue circle
    float diff = h1 - h0;
    if (diff >  0.5) diff -= 1.0;
    if (diff < -0.5) diff += 1.0;
    return fract(h0 + diff * f);
  }

  void main() {
    vec3 col = texture2D(uScene, vUv).rgb;

    // Palette hue traversal: rotate all hues by delta between palette[0] and palette[uHue]
    if (uHue > 0.001) {
      vec3  hsl   = rgb2hsl(col);
      float delta = palHueAt(uHue) - uPaletteHues[0];
      // Shortest-path delta
      if (delta >  0.5) delta -= 1.0;
      if (delta < -0.5) delta += 1.0;
      hsl.x = fract(hsl.x + delta);
      col   = hsl2rgb(hsl);
    }

    // Saturation (0 = grayscale, 1 = full colour)
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, uSaturation);

    // Brightness
    col = clamp(col * uBrightness, 0.0, 1.0);

    gl_FragColor = vec4(col, 1.0);
  }
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

  // ── Post-process pass ──────────────────────────────────────────────────────
  let rt = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
  });

  const postUniforms = {
    uScene:        { value: rt.texture },
    uHue:          { value: 0.0 },
    uSaturation:   { value: 1.0 },
    uBrightness:   { value: 1.0 },
    uPaletteHues:  { value: loadPaletteHues() },
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
  // ──────────────────────────────────────────────────────────────────────────

  function applySize(width: number, height: number) {
    size.width = width;
    size.height = height;
    renderer.setSize(width, height, false);
    rt.setSize(width, height);
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
  let paletteAge = 0;

  function loop(now: number) {
    const dt = (now - last) / 1000;
    const elapsed = (now - start) / 1000;
    last = now;
    current.update(dt * timeScale, elapsed);

    // Sync C2 globals into post-process uniforms
    postUniforms.uHue.value        = colorC2.hue;
    postUniforms.uSaturation.value = colorC2.saturation;
    postUniforms.uBrightness.value = colorC2.brightness;

    // Refresh palette hues from localStorage every 2 s
    paletteAge += dt;
    if (paletteAge > 2) {
      postUniforms.uPaletteHues.value = loadPaletteHues();
      paletteAge = 0;
    }

    // Render scene → RT, then post → canvas
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);

    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    setPattern,
    activateCurrentPattern() { current.activate?.(); },
    setTimeScale(v: number) { timeScale = Math.max(0, v); },
    getTimeScale() { return timeScale; },
    getCanvas() { return canvas; },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      current.dispose();
      clearScene();
      renderer.dispose();
      rt.dispose();
      postMaterial.dispose();
    },
  };
}
