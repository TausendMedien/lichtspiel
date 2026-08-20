import * as THREE from 'three';
import type { Pattern, PatternContext, PatternControl } from './types';
import { hyperMixHeat } from './hyperMixHeat';
import { particlesHeat } from './particlesHeat';
import { gravityLines } from './gravityLines';
import { parallelLinesStraight } from './parallelLinesStraight';
import { getSlots } from '../presets';
import { field, DESIGN_W } from '../pattern-engine/engine';

/**
 * Lustspiel Particle — the Lustspiel Organic idea (stacked layers, each with its
 * own atmosphere) but with the *elements taken from existing patterns* instead of
 * the Canvas2D vocabulary.
 *
 * Each element is one of the app's real patterns, hosted in its own THREE.Scene
 * and camera and rendered into its layer's render target. Because every one of
 * these four only ever touches ctx.scene / ctx.camera / ctx.size (none of them
 * grabs the renderer to do its own passes), they can be hosted side by side
 * without modification, and their Heat / Push / pose reactivity keeps working
 * untouched — those read global sensor state inside their own update() and
 * shaders, so simply calling update() is enough.
 *
 * Elements are assigned to 1..4 layers. A layer is composited with its own
 * Speed (how fast the elements on it run), Warp (a UV distortion of the whole
 * layer) and Atmosphere (the same uneven dissolve-and-darken as Lustspiel
 * Organic, here as a shader pass). Layer 1 is the front layer.
 *
 * Deliberately NOT exposed: the hosted patterns' own controls. Four patterns'
 * full control sets would be unusable. Instead the Preset 1/2/3 buttons load
 * each hosted pattern's *own* saved preset slot, so the boxes come from the
 * individual patterns exactly as they were dialled in there.
 */

const MAX_LAYERS = 4;

interface Source {
  id: string;
  label: string;
  pattern: Pattern;
}

const SOURCES: Source[] = [
  { id: 'hyperMixHeat', label: 'Hyper Mix', pattern: hyperMixHeat },
  { id: 'particlesHeat', label: 'Particle Field', pattern: particlesHeat },
  { id: 'gravityLines', label: 'Gravity Lines', pattern: gravityLines },
  { id: 'parallelLinesStraight', label: 'Parallel Lines', pattern: parallelLinesStraight },
];

// ─── Composite shader ─────────────────────────────────────────────────────────
// One pass per layer, additively blended onto the frame (these patterns are all
// light-on-black, same as the Canvas engine's "lighter" compositing).

const vert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const frag = /* glsl */`
  precision highp float;
  uniform sampler2D uTex;
  uniform sampler2D uMask;     // r = dissolve-into-wash, g = sink-into-dark
  uniform vec2  uTexel;
  uniform float uAtmo;
  uniform float uWarp;
  uniform float uTime;
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;

    // Per-layer Warp: a slow UV meander, so a layer can drift out of register
    // with the ones behind it without touching the hosted pattern's own geometry.
    if (uWarp > 0.001) {
      float a = sin(uv.y * 6.2831 * 1.3 + uTime * 0.7) * 0.5
              + sin(uv.y * 6.2831 * 2.7 - uTime * 0.4) * 0.25;
      float b = sin(uv.x * 6.2831 * 1.1 - uTime * 0.6) * 0.5
              + sin(uv.x * 6.2831 * 2.3 + uTime * 0.5) * 0.25;
      uv += vec2(a, b) * uWarp * 0.06;
    }
    uv = clamp(uv, 0.0, 1.0);

    vec3 sharp = texture2D(uTex, uv).rgb;

    vec2 m = texture2D(uMask, vUv).rg * uAtmo;

    vec3 outc = sharp;
    if (m.r > 0.001) {
      // 9-tap wide box blur — the "dissolve into a wash of colour" half.
      vec2 r = uTexel * 14.0;
      vec3 w = vec3(0.0);
      for (int i = -1; i <= 1; i++) {
        for (int j = -1; j <= 1; j++) {
          w += texture2D(uTex, clamp(uv + vec2(float(i), float(j)) * r, 0.0, 1.0)).rgb;
        }
      }
      w /= 9.0;
      outc = mix(outc, w, clamp(m.r, 0.0, 1.0));
    }
    // The "sink into darkness" half — this layer fades out here, so whatever is
    // behind it shows through instead.
    outc *= (1.0 - clamp(m.g, 0.0, 1.0));

    gl_FragColor = vec4(outc, 1.0);
  }
`;

// ─── Pattern ──────────────────────────────────────────────────────────────────

export function makeLustspielParticle(id: string, name: string): Pattern {
  /** Layer index per source, or -1 for off. Default: only Hyper Mix, on layer 1. */
  const assign: number[] = [0, -1, -1, -1];
  let layerCount = 1;

  const speed: number[] = [1, 1, 1, 1];
  const atmo: number[] = [0, 0.5, 0.65, 0.75];
  const warp: number[] = [0, 0, 0, 0];
  const layerTime: number[] = [0, 0, 0, 0];

  let seed = 4271;

  let renderer: THREE.WebGLRenderer | null = null;
  let size = { width: 1, height: 1 };
  let pixelRatio = 1;

  /** One hosted scene per source, created lazily when it is first switched on. */
  const scenes: (THREE.Scene | null)[] = [null, null, null, null];
  const cams: (THREE.PerspectiveCamera | null)[] = [null, null, null, null];
  const started: boolean[] = [false, false, false, false];

  const targets: (THREE.WebGLRenderTarget | null)[] = [null, null, null, null];
  const maskTex: (THREE.DataTexture | null)[] = [null, null, null, null];
  const maskData: (Uint8Array<ArrayBuffer> | null)[] = [null, null, null, null];

  // One composite quad per layer, living in the APP's scene. The app's own RAF
  // loop does renderer.render(scene, camera) right after update() returns, so
  // compositing to the screen inside update() would just be overwritten. These
  // draw as part of that render instead, back layer first via renderOrder.
  const quadMats: (THREE.ShaderMaterial | null)[] = [null, null, null, null];
  const quadMeshes: (THREE.Mesh | null)[] = [null, null, null, null];
  let quadGeo: THREE.PlaneGeometry | null = null;

  const MW = 24, MH = 14;

  function ensureSource(i: number) {
    if (started[i] || !renderer) return;
    const sc = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(60, size.width / Math.max(size.height, 1), 0.1, 100);
    cam.position.set(0, 0, 5);
    scenes[i] = sc; cams[i] = cam;
    SOURCES[i].pattern.init({ scene: sc, camera: cam, renderer, size });
    // Deliberately never activate(): for these sources that opens the camera,
    // and Lustspiel defaults every interaction off — switching to this pattern
    // must not demand camera access by itself. Heat / Push / pose reactivity
    // does not need it: those read the shared sensor state inside each hosted
    // pattern's own update() and shaders, which the app populates once the user
    // turns the camera on from the Interactive section.
    SOURCES[i].pattern.resize(size.width, size.height);
    started[i] = true;
  }

  function stopSource(i: number) {
    if (!started[i]) return;
    SOURCES[i].pattern.dispose();
    scenes[i] = null; cams[i] = null;
    started[i] = false;
  }

  function ensureTarget(l: number) {
    const w = Math.max(1, Math.round(size.width * pixelRatio));
    const h = Math.max(1, Math.round(size.height * pixelRatio));
    const t = targets[l];
    if (t && t.width === w && t.height === h) return t;
    t?.dispose();
    const nt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    targets[l] = nt;
    return nt;
  }

  /** Same two-field grime as Lustspiel Organic, packed into r (wash) and g (dark)
   *  of a tiny texture the shader samples — linear filtering blows it up into a
   *  soft gradient for free. */
  function updateMask(l: number) {
    if (!maskData[l]) {
      maskData[l] = new Uint8Array(new ArrayBuffer(MW * MH * 4));
      const tx = new THREE.DataTexture(maskData[l]!, MW, MH, THREE.RGBAFormat);
      tx.minFilter = THREE.LinearFilter;
      tx.magFilter = THREE.LinearFilter;
      tx.needsUpdate = true;
      maskTex[l] = tx;
    }
    const d = maskData[l]!;
    const t = layerTime[l];
    const H = DESIGN_W * (size.height / Math.max(size.width, 1));
    for (let my = 0; my < MH; my++) {
      for (let mx = 0; mx < MW; mx++) {
        const wx = ((mx + 0.5) / MW) * DESIGN_W, wy = ((my + 0.5) / MH) * H;
        // Layer index shifts both seed and sampling origin, so no two layers
        // dissolve in the same places.
        const a = field(wx * 0.55 + l * 210, wy * 0.55 + l * 130, seed + 500 + l * 97 + t * 0.3);
        const b = -field(wx * 0.45 + 300 + l * 170, wy * 0.45 + 300 + l * 90, seed + 640 + l * 61 + t * 0.3);
        const i = (my * MW + mx) * 4;
        d[i] = Math.round(Math.max(0, Math.min(1, a * 1.9)) * 255);
        d[i + 1] = Math.round(Math.max(0, Math.min(1, b * 1.9)) * 255);
        d[i + 2] = 0; d[i + 3] = 255;
      }
    }
    maskTex[l]!.needsUpdate = true;
  }

  function applyPresetSlot(idx: number) {
    for (let i = 0; i < SOURCES.length; i++) {
      if (assign[i] < 0) continue;
      const snap = getSlots(SOURCES[i].id)[idx];
      if (!snap) continue;
      for (const ctrl of SOURCES[i].pattern.controls ?? []) {
        if (ctrl.type === 'button' || ctrl.type === 'separator' || ctrl.type === 'section') continue;
        const v = snap[ctrl.label];
        if (v === undefined) continue;
        try { (ctrl.set as (x: unknown) => void)(v); } catch { /* control rejects it — skip */ }
      }
    }
  }

  const layerOptions = () => ['Off', ...Array.from({ length: layerCount }, (_, i) => `${i + 1}`)];

  const controls: PatternControl[] = [
    { label: 'Layers', type: 'separator' },
    { label: 'Add Layer', type: 'button',
      tip: 'Adds another layer behind the current ones. Layer 1 is the front layer.',
      action: () => { if (layerCount < MAX_LAYERS) layerCount++; } },
    { label: 'Remove Layer', type: 'button',
      tip: 'Removes the backmost layer. Any element on it moves up to the last remaining layer.',
      action: () => {
        if (layerCount <= 1) return;
        layerCount--;
        for (let i = 0; i < assign.length; i++) if (assign[i] >= layerCount) assign[i] = layerCount - 1;
      } },

    { label: 'Elements', type: 'separator' },
    ...SOURCES.map((s, i) => ({
      label: s.label, type: 'buttons' as const,
      options: layerOptions,
      tip: `${s.label} — Off, or which layer it lives on. Its Heat / Push / pose reactivity works exactly as in the original pattern.`,
      get: () => (assign[i] < 0 ? 0 : assign[i] + 1),
      set: (v: number) => {
        const next = v <= 0 ? -1 : Math.min(layerCount - 1, v - 1);
        assign[i] = next;
        if (next < 0) stopSource(i); else ensureSource(i);
      },
    })),

    { label: 'Identity', type: 'separator' },
    { label: 'Seed', type: 'stepper', min: 1, max: 9999, step: 1,
      tip: 'Picks the atmosphere patch layout. The same seed always gives the same grime.',
      get: () => seed, set: (v: number) => { seed = Math.round(v); } },
    { label: 'New Seed', type: 'button', tip: 'Roll a new atmosphere layout.',
      action: () => { seed = 1 + Math.floor(Math.random() * 9999); } },

    // Per-layer controls for all four layers exist up front and grey out above
    // the current layer count. The controls array itself cannot grow at runtime:
    // wrapWithPersist copies it once at module load, so a later push would never
    // reach the app.
    ...Array.from({ length: MAX_LAYERS }, (_, l) => ([
      { label: `Layer ${l + 1}`, type: 'separator' as const },
      { label: `L${l + 1} Speed`, type: 'range' as const, min: 0, max: 2, step: 0.01, default: 1,
        tip: 'How fast the elements on this layer run. 0 freezes them.',
        disabled: () => l >= layerCount,
        get: () => speed[l], set: (v: number) => { speed[l] = v; } },
      { label: `L${l + 1} Atmosphere`, type: 'range' as const, min: 0, max: 1, step: 0.01,
        default: l === 0 ? 0 : [0, 0.5, 0.65, 0.75][l],
        tip: 'Uneven grime on this layer only: patches dissolve into a wash of colour, others sink toward black so the layers behind show through.',
        disabled: () => l >= layerCount,
        get: () => atmo[l], set: (v: number) => { atmo[l] = v; } },
      { label: `L${l + 1} Warp`, type: 'range' as const, min: 0, max: 1, step: 0.01, default: 0,
        tip: 'Bends this whole layer, so it drifts out of register with the layers behind it.',
        disabled: () => l >= layerCount,
        get: () => warp[l], set: (v: number) => { warp[l] = v; } },
    ] as PatternControl[])).flat(),

    { label: 'Presets from source patterns', type: 'separator' },
    ...[0, 1, 2].map(i => ({
      label: `Load Preset ${i + 1}`, type: 'button' as const,
      tip: `Loads slot ${i + 1} of each active element from that pattern's own saved presets.`,
      action: () => applyPresetSlot(i),
    })),
  ];

  return {
    id,
    name,
    // Move and Audio drive the layer speeds — the hosted patterns' own controls
    // are deliberately not exposed, so their sliders are not available as targets.
    // Heat / Push / pose reactivity needs no wiring: those read global sensor
    // state inside each hosted pattern's own update() and shaders.
    motionControlLabels: ['L1 Speed', 'L2 Speed'],
    audioControlLabels: ['L1 Speed', 'L2 Speed'],
    heatReactive: true,
    controls,

    init(ctx: PatternContext) {
      renderer = ctx.renderer;
      size = { width: ctx.size.width, height: ctx.size.height };
      pixelRatio = ctx.renderer.getPixelRatio();

      quadGeo = new THREE.PlaneGeometry(2, 2);
      for (let l = 0; l < MAX_LAYERS; l++) {
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uTex: { value: null },
            uMask: { value: null },
            uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
            uAtmo: { value: 0 },
            uWarp: { value: 0 },
            uTime: { value: 0 },
          },
          vertexShader: vert,
          fragmentShader: frag,
          depthTest: false,
          depthWrite: false,
          transparent: true,
          blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Mesh(quadGeo, mat);
        mesh.frustumCulled = false;
        // Higher layer index = further back = drawn first.
        mesh.renderOrder = MAX_LAYERS - l;
        mesh.visible = l < layerCount;
        quadMats[l] = mat; quadMeshes[l] = mesh;
        ctx.scene.add(mesh);
      }

      for (let i = 0; i < SOURCES.length; i++) if (assign[i] >= 0) ensureSource(i);
    },

    update(dt: number, elapsed: number) {
      if (!renderer) return;

      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;

      // The composite quads must not appear in their own layer renders.
      for (let l = 0; l < MAX_LAYERS; l++) if (quadMeshes[l]) quadMeshes[l]!.visible = false;

      // ── render each layer into its own target ──
      for (let l = 0; l < layerCount; l++) {
        layerTime[l] += dt * speed[l];
        const rt = ensureTarget(l);
        renderer.setRenderTarget(rt);
        renderer.autoClear = true;
        renderer.clear(true, true, true);
        renderer.autoClear = false;
        for (let i = 0; i < SOURCES.length; i++) {
          if (assign[i] !== l || !started[i] || !scenes[i] || !cams[i]) continue;
          SOURCES[i].pattern.update(dt * speed[l], elapsed);
          renderer.render(scenes[i]!, cams[i]!);
        }
      }

      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;

      // ── hand the layers to the app's own render pass ──
      for (let l = 0; l < MAX_LAYERS; l++) {
        const mesh = quadMeshes[l], mat = quadMats[l], rt = targets[l];
        if (!mesh || !mat) continue;
        const on = l < layerCount && !!rt;
        mesh.visible = on;
        if (!on) continue;
        updateMask(l);
        mat.uniforms.uTex.value = rt!.texture;
        mat.uniforms.uMask.value = maskTex[l];
        (mat.uniforms.uTexel.value as THREE.Vector2).set(1 / rt!.width, 1 / rt!.height);
        mat.uniforms.uAtmo.value = atmo[l];
        mat.uniforms.uWarp.value = warp[l];
        mat.uniforms.uTime.value = layerTime[l];
      }
    },

    resize(width: number, height: number) {
      size = { width, height };
      for (let i = 0; i < SOURCES.length; i++) {
        if (!started[i] || !cams[i]) continue;
        cams[i]!.aspect = width / Math.max(height, 1);
        cams[i]!.updateProjectionMatrix();
        SOURCES[i].pattern.resize(width, height);
      }
      for (let l = 0; l < MAX_LAYERS; l++) if (targets[l]) ensureTarget(l);
    },

    dispose() {
      for (let i = 0; i < SOURCES.length; i++) stopSource(i);
      for (let l = 0; l < MAX_LAYERS; l++) {
        targets[l]?.dispose(); targets[l] = null;
        maskTex[l]?.dispose(); maskTex[l] = null; maskData[l] = null;
      }
      quadGeo?.dispose();
      for (let l = 0; l < MAX_LAYERS; l++) { quadMats[l]?.dispose(); quadMats[l] = null; quadMeshes[l] = null; }
      quadGeo = null;
      renderer = null;
    },
  };
}
