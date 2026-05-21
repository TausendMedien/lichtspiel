import * as THREE from "three";
import type { Pattern, PatternContext } from "./patterns/types";
import { colorC2 } from "./colorC2.svelte";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
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
  uniform vec3  uHaupt;
  uniform vec3  uKontrast;
  uniform vec3  uGlow;
  uniform float uSaturation;
  uniform float uBrightness;
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

    // ── Hue warp: map source arc [0.50 cyan → 0.83 magenta] to [Haupt → Kontrast] ──
    vec3  hsl  = rgb2hsl(col);
    float h    = hsl.x;
    float s    = hsl.y;
    float l    = hsl.z;

    float srcA    = 0.50;
    float srcSpan = 0.33;                          // 0.83 - 0.50
    float pos     = fract(h - srcA + 1.0);         // forward distance from cyan
    float t       = clamp(pos / srcSpan, 0.0, 1.0);

    // Target hues from user colours (shortest-arc lerp)
    vec3  hslA = rgb2hsl(uHaupt);
    vec3  hslB = rgb2hsl(uKontrast);
    float hA   = hslA.x;
    float hB   = hslB.x;
    float diff = hB - hA;
    if (diff >  0.5) diff -= 1.0;
    if (diff < -0.5) diff += 1.0;
    float mappedHue = fract(hA + diff * t);

    vec3 remapped = hsl2rgb(vec3(mappedHue, s, l));

    // ── Glow: tint the brightest pixels toward the Glow colour ──────────────────
    float glowW = smoothstep(0.75, 1.0, l);
    remapped = mix(remapped, uGlow, glowW * 0.75);

    col = remapped;

    // ── Saturation ───────────────────────────────────────────────────────────────
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, uSaturation);

    // ── Brightness ───────────────────────────────────────────────────────────────
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
    uScene:      { value: rt.texture },
    uHaupt:      { value: new THREE.Vector3(...hexToRgb(colorC2.haupt)) },
    uKontrast:   { value: new THREE.Vector3(...hexToRgb(colorC2.kontrast)) },
    uGlow:       { value: new THREE.Vector3(...hexToRgb(colorC2.glow)) },
    uSaturation: { value: colorC2.saturation },
    uBrightness: { value: colorC2.brightness },
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

  function loop(now: number) {
    const dt = (now - last) / 1000;
    const elapsed = (now - start) / 1000;
    last = now;
    current.update(dt * timeScale, elapsed);

    // Sync colour state into post-process uniforms every frame
    const [hR, hG, hB] = hexToRgb(colorC2.haupt);
    postUniforms.uHaupt.value.set(hR, hG, hB);
    const [kR, kG, kB] = hexToRgb(colorC2.kontrast);
    postUniforms.uKontrast.value.set(kR, kG, kB);
    const [gR, gG, gB] = hexToRgb(colorC2.glow);
    postUniforms.uGlow.value.set(gR, gG, gB);
    postUniforms.uSaturation.value = colorC2.saturation;
    postUniforms.uBrightness.value = colorC2.brightness;

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
