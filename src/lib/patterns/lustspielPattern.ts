import * as THREE from 'three';
import type { Pattern, PatternContext, PatternControl } from './types';
import type { EngineState, ElementId, PhaseId } from '../pattern-engine/types';
import { paint, DESIGN_W } from '../pattern-engine/engine';
import { colorC2, getEnabledIndices, getColorByIndex } from '../colorC2.svelte';

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

/** Element order is fixed, so the zone slot of an element does not shift when
 *  another one is switched on or off. */
const ELEMENTS: { id: ElementId; label: string; tip: string }[] = [
  { id: 1, label: 'Points', tip: 'Dots — either a jittered grid, chains along bent strands, or a flowing field.' },
  { id: 2, label: 'Lines',  tip: 'Long bent strands of varying thickness.' },
  { id: 3, label: 'Mesh',   tip: 'A net of nodes connected to their neighbours.' },
  { id: 4, label: 'Rings',  tip: 'Concentric rings around an off-centre point.' },
];

const POINT_STYLES = ['Grid', 'Strands', 'Wave'] as const;
const POINT_STYLE_VALUES: EngineState['pointStyle'][] = ['grid', 'strands', 'wave'];

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeLustspielPattern(id: string, name: string, phase: PhaseId): Pattern {
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

  /** Which elements are on, keyed by element id — the toggles write here. */
  const on: Record<ElementId, boolean> = { 1: true, 2: false, 3: false, 4: false };
  let useAppPalette = false;
  let lastPaletteKey = '';

  let canvas: HTMLCanvasElement | null = null;
  let c2d: CanvasRenderingContext2D | null = null;
  let texture: THREE.CanvasTexture | null = null;
  let mesh: THREE.Mesh | null = null;
  let material: THREE.ShaderMaterial | null = null;
  let geometry: THREE.PlaneGeometry | null = null;

  let pixelRatio = 1;
  let dirty = true;

  const touch = () => { dirty = true; };
  const multi = () => state.elems.length > 1;

  /** Rebuild elems from the toggles, keeping the fixed order and never emptying it. */
  function syncElems() {
    const next = ELEMENTS.filter(e => on[e.id]).map(e => e.id);
    state.elems = next.length ? next : [1];
    if (!next.length) on[1] = true;
    touch();
  }

  /** Signature of the app palette — lets update() notice colour edits. */
  function paletteKey(): string {
    return getEnabledIndices().map(getColorByIndex).join(',');
  }

  function applyPalette() {
    if (!useAppPalette) { state.palette = undefined; return; }
    const cols = getEnabledIndices().map(getColorByIndex);
    // The phase palettes hold five entries; repeat the app colours so the
    // colour picking inside the engine spreads across the same range.
    state.palette = cols.length >= 5 ? cols : Array.from({ length: 5 }, (_, i) => cols[i % cols.length]);
  }

  function repaint() {
    if (!canvas || !c2d || !texture) return;
    const scale = canvas.width / DESIGN_W;
    const logicalH = canvas.height / scale;
    const t0 = performance.now();
    applyPalette();
    paint(c2d, scale, logicalH, state);
    const ms = performance.now() - t0;
    if (ms > 100) console.debug(`[${id}] repaint took ${ms.toFixed(0)} ms`);
    texture.needsUpdate = true;
    dirty = false;
  }

  function resizeCanvas(width: number, height: number) {
    if (!canvas) return;
    const w = Math.max(1, Math.round(width * pixelRatio));
    const h = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    dirty = true;
  }

  const controls: PatternControl[] = [
    // ── Elements ─────────────────────────────────────────────────────────────
    ...ELEMENTS.map(e => ({
      label: e.label, type: 'toggle' as const, tip: e.tip,
      get: () => on[e.id],
      set: (v: boolean) => { on[e.id] = v; syncElems(); },
    })),

    // ── Shape ────────────────────────────────────────────────────────────────
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
    { label: 'Organic', type: 'range', min: 0, max: 1, step: 0.05, default: 0,
      tip: 'From regular waves to an irregular, vine-like meander.',
      get: () => state.organic, set: v => { state.organic = v; touch(); } },

    { label: 'Point Style', type: 'select', options: [...POINT_STYLES],
      tip: 'Grid: a jittered raster. Strands: dot chains along bent paths. Wave: dots carried by a flow.',
      disabled: () => !on[1],
      get: () => POINT_STYLE_VALUES.indexOf(state.pointStyle),
      set: v => { state.pointStyle = POINT_STYLE_VALUES[v] ?? 'strands'; touch(); } },
    { label: 'Line Direction', type: 'select', options: ['Vertical', 'Horizontal'],
      tip: 'Turns the line direction by 90°. Nothing is cropped — the pattern is generated along the other axis. Use it to compensate a rotated projector, or because upright and lying lines read very differently on a dancing body.',
      disabled: () => !(on[2] || (on[1] && state.pointStyle !== 'grid')),
      get: () => (state.lineDir === 'v' ? 0 : 1),
      set: v => { state.lineDir = v === 0 ? 'v' : 'h'; touch(); } },

    // ── Composition — only meaningful with two or more elements ───────────────
    { label: 'Composition', type: 'select', options: ['Bands', 'Blobs'],
      tip: 'How the surface is divided between elements: flowing bands, or amorphous blobs with a dark seam.',
      disabled: () => !multi(),
      get: () => (state.comp === 'bands' ? 0 : 1),
      set: v => { state.comp = v === 0 ? 'bands' : 'blobs'; touch(); } },
    { label: 'Arrangement', type: 'select', options: ['Chaotic', 'Side by side'],
      tip: 'Chaotic scatters the zones over the whole surface. Side by side puts one element left and the next right, with a meandering seam and a mixed middle.',
      disabled: () => !multi(),
      get: () => (state.layout === 'chaotic' ? 0 : 1),
      set: v => { state.layout = v === 0 ? 'chaotic' : 'sideBySide'; touch(); } },
    { label: 'Zones', type: 'range', min: 2, max: 6, step: 1, default: 3,
      tip: 'How many zones the surface is divided into.',
      disabled: () => !multi(),
      get: () => state.zones, set: v => { state.zones = Math.round(v); touch(); } },
    { label: 'Interlock', type: 'range', min: 0, max: 1, step: 0.05, default: 0.35,
      tip: 'How much neighbouring zones reach into each other at their edge.',
      disabled: () => !multi(),
      get: () => state.lock, set: v => { state.lock = v; touch(); } },

    // ── Phase A/C only — both are mathematically inert in B ───────────────────
    { label: 'Thinning', type: 'range', min: 0, max: 60, step: 1, default: 20,
      tip: 'Removes elements in phases A and C — fewer marks, not a dimmer image. No effect in phase B.',
      disabled: () => phase === 'B',
      get: () => state.pk, set: v => { state.pk = Math.round(v); touch(); } },
    { label: 'Gradient', type: 'range', min: 0, max: 1, step: 0.05, default: 0.3,
      tip: 'Darkens one edge of the image in phases A and C. No effect in phase B.',
      disabled: () => phase === 'B',
      get: () => state.grad, set: v => { state.grad = v; touch(); } },

    // ── Identity ─────────────────────────────────────────────────────────────
    { label: 'Seed', type: 'range', min: 1, max: 9999, step: 1, default: 7,
      tip: 'Picks one specific pattern out of all possible ones. The same seed always gives the same image.',
      get: () => state.seed, set: v => { state.seed = Math.round(v); touch(); } },
    { label: 'New Seed', type: 'button',
      tip: 'Roll a new random seed — a completely different pattern, same settings.',
      action: () => { state.seed = 1 + Math.floor(Math.random() * 9999); touch(); } },
    { label: 'Palette', type: 'select', options: ['Film', 'Lichtspiel'],
      tip: 'Film uses the fixed colours of this phase. Lichtspiel uses the global colour palette above, so you can change the colours live.',
      get: () => (useAppPalette ? 1 : 0),
      set: v => { useAppPalette = v === 1; lastPaletteKey = paletteKey(); touch(); } },

    { label: 'Apply to all Lustspiel patterns', type: 'button',
      tip: 'Copies these settings onto the other Lustspiel phases, so you only have to dial them in once.',
      action: () => { void applyToAll(id); } },
  ];

  return {
    id,
    name,
    // Coverage and Organic are intensity and shape — never Seed or Zones, which
    // decide *which* elements exist and would make the image jump.
    motionControlLabels: ['Coverage', 'Organic'],
    controls,

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

      syncElems();
      lastPaletteKey = paletteKey();
      repaint();
    },

    update() {
      // Colour edits happen in the global palette, outside this pattern's controls.
      if (useAppPalette) {
        const key = paletteKey();
        if (key !== lastPaletteKey) { lastPaletteKey = key; dirty = true; }
      }
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

/**
 * Copies the current control values onto the other Lustspiel patterns by writing
 * their persistence keys and re-reading them. Imported lazily because
 * patterns/index.ts imports this module.
 */
async function applyToAll(sourceId: string) {
  const [{ patterns }, { restoreFromKeys }] = await Promise.all([
    import('./index'),
    import('../persist'),
  ]);
  const source = patterns.find(p => p.id === sourceId);
  if (!source) return;
  const targets = patterns.filter(p => p.id.startsWith('lsp-') && p.id !== sourceId);
  for (const ctrl of source.controls ?? []) {
    if (ctrl.type === 'button' || ctrl.type === 'separator' || ctrl.type === 'section') continue;
    const value = ctrl.get();
    const raw = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    for (const t of targets) {
      try { localStorage.setItem(`pp:${t.id}:${ctrl.label}`, raw); } catch {}
    }
  }
  restoreFromKeys(targets);
}
