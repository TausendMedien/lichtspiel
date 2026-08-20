import * as THREE from 'three';
import type { Pattern, PatternContext, PatternControl } from './types';
import type { EngineState, ElementId, PhaseId } from '../pattern-engine/types';
import { paint, PHASE, DESIGN_W, mixHex } from '../pattern-engine/engine';
import { getEnabledIndices, getColorByIndex } from '../colorC2.svelte';

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
const ARRANGEMENTS = ['Chaotic', 'Left / Right', 'Up / Down'] as const;
const ARRANGEMENT_VALUES: EngineState['arrangement'][] = ['chaotic', 'leftRight', 'upDown'];

const DEFAULT_SEED = 8685;

/** Radians of field()/zoneU() phase per second at Speed = 1 — tuned so even full
 *  speed drifts rather than boils: a full 2π cycle takes well over ten seconds.
 *  hash() is never touched, so which shapes exist never changes, only their form. */
const TIME_RATE = 0.5;

export interface LustspielOptions {
  /** Overrides applied on top of the built-in defaults below. */
  defaults?: Partial<EngineState>;
  /** Adds the Speed control and drives state.time from it every frame. */
  animated?: boolean;
  /** Speed control default (0 = static, 1 = full drift). Only used when animated. */
  speedDefault?: number;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeLustspielPattern(id: string, name: string, phase: PhaseId, opts?: LustspielOptions): Pattern {
  const state: EngineState = {
    phase,
    elems: [1],
    comp: 'blobs',
    arrangement: 'chaotic',
    pointStyle: 'strands',
    lineDir: 'v',
    dens: 2,
    stroke: 1,
    warp: 1,
    organic: 0,
    zones: 3,
    lock: 0.35,
    pk: 20,
    seed: DEFAULT_SEED,
    colorSoftness: 0,
    strictness: 0.65,
    ...opts?.defaults,
    time: 0,
    animated: !!opts?.animated,
  };
  let speed = opts?.animated ? (opts.speedDefault ?? 0.15) : 0;

  /** Which elements are on, keyed by element id — the toggles write here.
   *  Seeded from state.elems (defaults or an opts.defaults override), not
   *  hardcoded — syncElems() below rebuilds state.elems from this on first
   *  init() and would otherwise silently discard a non-[1] elems default. */
  const on: Record<ElementId, boolean> = { 1: false, 2: false, 3: false, 4: false };
  for (const el of state.elems) on[el] = true;
  /** 0 = Film (fixed phase colours), 1 = Default (the app's global palette). */
  let paletteBlend = 0.5;
  let lastAppPaletteKey = '';

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
  /** Zones only changes anything for blobs, or for bands while scattered — once
   *  bands are ordered left/right or up/down the band count must equal the
   *  element count, so Zones has nothing left to do (see engine.ts zoneU()). */
  const zonesMatter = () => multi() && (state.comp === 'blobs' || state.arrangement === 'chaotic');

  /** Rebuild elems from the toggles, keeping the fixed order and never emptying it. */
  function syncElems() {
    const next = ELEMENTS.filter(e => on[e.id]).map(e => e.id);
    state.elems = next.length ? next : [1];
    if (!next.length) on[1] = true;
    touch();
  }

  /** Signature of the app palette — lets update() notice colour edits. */
  function appPaletteKey(): string {
    return getEnabledIndices().map(getColorByIndex).join(',');
  }

  /** Blends this phase's fixed palette with the app's global palette, per entry. */
  function applyPalette() {
    const filmPal = PHASE[phase].pal;
    const appColors = getEnabledIndices().map(getColorByIndex);
    const appPal = appColors.length >= filmPal.length
      ? appColors.slice(0, filmPal.length)
      : Array.from({ length: filmPal.length }, (_, i) => appColors[i % appColors.length]);
    state.palette = filmPal.map((f, i) => mixHex(f, appPal[i], paletteBlend));
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
    { label: 'Elements', type: 'separator' },
    ...ELEMENTS.map(e => ({
      label: e.label, type: 'toggle' as const, tip: e.tip,
      get: () => on[e.id],
      set: (v: boolean) => { on[e.id] = v; syncElems(); },
    })),

    // ── Identity ─────────────────────────────────────────────────────────────
    { label: 'Identity', type: 'separator' },
    { label: 'Seed', type: 'stepper', min: 1, max: 9999, step: 1,
      tip: 'Picks one specific pattern out of all possible ones. The same seed always gives the same image.',
      get: () => state.seed, set: v => { state.seed = Math.round(v); touch(); } },
    { label: 'New Seed', type: 'button',
      tip: 'Roll a new random seed — a completely different pattern, same settings.',
      action: () => { state.seed = 1 + Math.floor(Math.random() * 9999); touch(); } },

    // ── Shape — how each element looks and moves ──────────────────────────────
    { label: 'Shape', type: 'separator' },
    { label: 'Density', type: 'range', min: 0.4, max: 2.4, step: 0.05, default: 2,
      tip: 'How closely the strands, dots or rings sit together.',
      get: () => state.dens, set: v => { state.dens = v; touch(); } },
    { label: 'Stroke Width', type: 'range', min: 0.5, max: 1.5, step: 0.05, default: 1,
      tip: 'Thickness of every mark. Decides whether the pattern still reads on a moving body.',
      get: () => state.stroke, set: v => { state.stroke = v; touch(); } },
    { label: 'Warp', type: 'range', min: 0, max: 2.5, step: 0.05, default: 1,
      tip: 'How strongly the strands bend away from a straight path.',
      get: () => state.warp, set: v => { state.warp = v; touch(); } },
    { label: 'Organic', type: 'range', min: 0, max: 1, step: 0.05, default: 0,
      tip: 'From regular waves to a wild, irregular, vine-like meander — both the shape and the amplitude grow with this slider.',
      get: () => state.organic, set: v => { state.organic = v; touch(); } },
    { label: 'Point Style', type: 'buttons', options: [...POINT_STYLES],
      tip: 'Grid: a jittered raster. Strands: dot chains along bent paths. Wave: dots carried by a flow.',
      disabled: () => !on[1],
      get: () => POINT_STYLE_VALUES.indexOf(state.pointStyle),
      set: v => { state.pointStyle = POINT_STYLE_VALUES[v] ?? 'strands'; touch(); } },
    { label: 'Line Direction', type: 'buttons', options: ['Vertical', 'Horizontal'],
      tip: 'Turns the line direction by 90°. Nothing is cropped — the pattern is generated along the other axis. Use it to compensate a rotated projector, or because upright and lying lines read very differently on a dancing body.',
      disabled: () => !(on[2] || (on[1] && state.pointStyle !== 'grid')),
      get: () => (state.lineDir === 'v' ? 0 : 1),
      set: v => { state.lineDir = v === 0 ? 'v' : 'h'; touch(); } },

    // ── Composition — how several elements share the surface ──────────────────
    { label: 'Composition', type: 'separator' },
    { label: 'Zone Shape', type: 'buttons', options: ['Bands', 'Blobs'],
      tip: 'How the surface is divided between elements: flowing bands, or amorphous blobs with a dark seam.',
      disabled: () => !multi(),
      get: () => (state.comp === 'bands' ? 0 : 1),
      set: v => { state.comp = v === 0 ? 'bands' : 'blobs'; touch(); } },
    { label: 'Arrangement', type: 'buttons', options: [...ARRANGEMENTS],
      tip: 'Chaotic scatters the zones over the whole surface. Left/Right and Up/Down give each element its own side, in order.',
      disabled: () => !multi(),
      get: () => ARRANGEMENT_VALUES.indexOf(state.arrangement),
      set: v => { state.arrangement = ARRANGEMENT_VALUES[v] ?? 'chaotic'; touch(); } },
    { label: 'Strictness', type: 'range', min: 0, max: 1, step: 0.05, default: 0.65,
      tip: 'Only for Left/Right and Up/Down: how unambiguous the split is. 0 lets sides blend and overlap — can look chaotic. 1 gives a clean, obvious split. No effect on Chaotic.',
      disabled: () => !multi() || state.arrangement === 'chaotic',
      get: () => state.strictness, set: v => { state.strictness = v; touch(); } },
    { label: 'Zones', type: 'range', min: 2, max: 6, step: 1, default: 3,
      tip: 'Blobs: how many clusters each element gets — more clusters, more scattered. Bands: only affects Chaotic (Left/Right and Up/Down always use one band per element).',
      disabled: () => !zonesMatter(),
      get: () => state.zones, set: v => { state.zones = Math.round(v); touch(); } },
    { label: 'Interlock', type: 'range', min: 0, max: 1, step: 0.05, default: 0.35,
      tip: 'How much neighbouring zones reach into each other at their edge — from a sharp dark seam to an almost seamless blend.',
      disabled: () => !multi(),
      get: () => state.lock, set: v => { state.lock = v; touch(); } },

    // ── Phase timing ─────────────────────────────────────────────────────────
    { label: 'Phase Timing', type: 'separator' },
    { label: 'Thinning', type: 'range', min: 0, max: 60, step: 1, default: 20,
      tip: 'Removes elements — fewer marks, not a dimmer image.',
      get: () => state.pk, set: v => { state.pk = Math.round(v); touch(); } },

    // ── Motion — only for the animated Lustspiel 1/2/3 patterns ────────────────
    ...(opts?.animated ? [
      { label: 'Motion', type: 'separator' as const },
      { label: 'Speed', type: 'range' as const, min: 0, max: 1, step: 0.01, default: opts.speedDefault ?? 0.15,
        tip: '0 holds the image still. Higher values let it slowly drift — the same shapes stay, in the same places, only their form wanders. Which elements exist never changes (that stays fixed by Seed), so it never flickers.',
        get: () => speed, set: (v: number) => { speed = v; touch(); } },
    ] : []),

    // ── Colour ───────────────────────────────────────────────────────────────
    { label: 'Colour', type: 'separator' },
    { label: 'Palette', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5,
      tip: 'Left: Film — this phase’s fixed colours. Right: Default — the app’s global colour palette above, changeable live. In between: a blend of both.',
      get: () => paletteBlend, set: v => { paletteBlend = v; touch(); } },
    { label: 'Colour Blend', type: 'range', min: 0, max: 1, step: 0.05, default: 0,
      tip: 'Hard (0): each shape picks one stepped colour, like today. Soft (1): a smooth gradient across the palette, like the soft blends in Gravity Lines.',
      get: () => state.colorSoftness, set: v => { state.colorSoftness = v; touch(); } },

    // ── Sync ─────────────────────────────────────────────────────────────────
    { label: 'All Phases', type: 'separator' },
    { label: 'Apply to all Lustspiel patterns', type: 'button',
      tip: 'Copies these settings onto the other Lustspiel phases, so you only have to dial them in once.',
      action: () => { void applyToAll(id); } },
  ];

  return {
    id,
    name,
    // Organic is shape, never Seed or Zones, which decide *which* elements exist
    // and would make the image jump.
    motionControlLabels: ['Organic', 'Warp'],
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
      lastAppPaletteKey = appPaletteKey();
      repaint();
    },

    update(dt: number) {
      if (speed > 0) {
        state.time = (state.time ?? 0) + dt * speed * TIME_RATE;
        dirty = true;
      }
      // Colour edits happen in the global palette, outside this pattern's controls
      // — only worth checking while the blend actually uses them.
      if (paletteBlend > 0) {
        const key = appPaletteKey();
        if (key !== lastAppPaletteKey) { lastAppPaletteKey = key; dirty = true; }
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
