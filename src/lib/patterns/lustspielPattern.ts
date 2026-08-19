import * as THREE from 'three';
import type { Pattern, PatternContext } from './types';
import type { EngineState, PhaseId } from '../pattern-engine/types';
import { paint, DESIGN_W } from '../pattern-engine/engine';

// ─── Shaders ──────────────────────────────────────────────────────────────────
// The canvas is drawn at the output resolution, so the texture maps 1:1 onto the
// screen: no cover crop, no stretching, no borders — and no resampling blur.

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  precision highp float;
  uniform sampler2D uTexture;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(uTexture, vUv).rgb, 1.0);
  }
`;

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeLustspielPattern(id: string, name: string, phase: PhaseId): Pattern {
  // ── Engine state ───────────────────────────────────────────────────────────
  const state: EngineState = {
    phase,
    elems: [1],
    comp: 'blobs',
    layout: 'chaotic',
    pointStyle: 'strands',
    lineDir: 'v',
    occ: 0.7,
    dens: 1,
    stroke: 1,
    warp: 1,
    organic: 0,
    zones: 3,
    lock: 0.35,
    pk: 20,
    grad: 0.3,
    seed: 7,
  };

  let canvas: HTMLCanvasElement | null = null;
  let c2d: CanvasRenderingContext2D | null = null;
  let texture: THREE.CanvasTexture | null = null;
  let mesh: THREE.Mesh | null = null;
  let material: THREE.ShaderMaterial | null = null;
  let geometry: THREE.PlaneGeometry | null = null;

  let pixelRatio = 1;
  let dirty = true;

  /** Redraw the offscreen canvas. Called on change and on resize — never per frame. */
  function repaint() {
    if (!canvas || !c2d || !texture) return;
    const scale = canvas.width / DESIGN_W;
    const logicalH = canvas.height / scale;
    const t0 = performance.now();
    paint(c2d, scale, logicalH, state);
    const ms = performance.now() - t0;
    if (ms > 100) console.debug(`[${id}] repaint took ${ms.toFixed(0)} ms`);
    texture.needsUpdate = true;
    dirty = false;
  }

  const touch = () => { dirty = true; };

  function resizeCanvas(width: number, height: number) {
    if (!canvas) return;
    const w = Math.max(1, Math.round(width * pixelRatio));
    const h = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    dirty = true;
  }

  return {
    id,
    name,
    motionControlLabels: ['Coverage', 'Warp'],

    controls: [
      { label: 'Coverage', type: 'range', min: 0.15, max: 1, step: 0.01, default: 0.7,
        tip: 'How much of the surface carries pattern. Raises the brightness floor without adding elements.',
        get: () => state.occ, set: v => { state.occ = v; touch(); } },
      { label: 'Density', type: 'range', min: 0.4, max: 2.4, step: 0.05, default: 1,
        tip: 'How closely the strands, dots or rings sit together.',
        get: () => state.dens, set: v => { state.dens = v; touch(); } },
      { label: 'Stroke Width', type: 'range', min: 0.2, max: 1.5, step: 0.05, default: 1,
        tip: 'Thickness of every mark. Decides whether the pattern still reads on a moving body.',
        get: () => state.stroke, set: v => { state.stroke = v; touch(); } },
      { label: 'Warp', type: 'range', min: 0, max: 2.5, step: 0.05, default: 1,
        tip: 'How strongly the strands bend away from a straight path.',
        get: () => state.warp, set: v => { state.warp = v; touch(); } },
      { label: 'Seed', type: 'range', min: 1, max: 9999, step: 1, default: 7,
        tip: 'Picks one specific pattern out of all possible ones. The same seed always gives the same image.',
        get: () => state.seed, set: v => { state.seed = Math.round(v); touch(); } },
      { label: 'New Seed', type: 'button',
        tip: 'Roll a new random seed — a completely different pattern, same settings.',
        action: () => { state.seed = 1 + Math.floor(Math.random() * 9999); touch(); } },
    ],

    init(ctx: PatternContext) {
      pixelRatio = ctx.renderer.getPixelRatio();

      canvas = document.createElement('canvas');
      c2d = canvas.getContext('2d');
      resizeCanvas(ctx.size.width, ctx.size.height);

      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;   // 1:1 mapping — mipmaps would only soften
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;

      geometry = new THREE.PlaneGeometry(2, 2);
      material = new THREE.ShaderMaterial({
        uniforms: { uTexture: { value: texture } },
        vertexShader,
        fragmentShader,
        depthTest: false,
        depthWrite: false,
      });

      mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      ctx.scene.add(mesh);

      repaint();
    },

    update() {
      if (dirty) repaint();
    },

    resize(width: number, height: number) {
      resizeCanvas(width, height);
    },

    dispose() {
      geometry?.dispose();
      material?.dispose();
      texture?.dispose();
      mesh = null; geometry = null; material = null; texture = null;
      canvas = null; c2d = null;
    },
  };
}
