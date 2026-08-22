import * as THREE from 'three';
import type { Pattern, PatternContext, PatternControl } from './types';
import type { EngineState, ElementId, PhaseId } from '../pattern-engine/types';
import { paint, PHASE, DESIGN_W, mixHex, buildZoneMask, field, type ZoneInput } from '../pattern-engine/engine';
import { getEnabledIndices, getColorByIndex } from '../colorC2.svelte';
import { getSlots } from '../presets';
import { SOURCES, GAIN_DEFAULT, compositeVert, compositeFrag } from './lustspielParticle';
import { createRepaintScheduler } from './repaintScheduler';

/**
 * Lustspiel Alpha / Beta / Gamma — combines the Canvas2D vocabulary (Points,
 * Lines, Mesh, Rings, Gravity — the same five elements Lustspiel 1/2/3 use)
 * with the four hosted WebGL elements Lustspiel Particle uses (Particle
 * Field, Gravity Lines, Hyper Mix, Parallel Lines), all nine sharing ONE
 * ordered list and ONE zone partition, as if they were all on one Photoshop
 * layer with masks.
 *
 * How the two families share a partition: every zone function in engine.ts
 * derives the partition only from `elems.length`, `comp`, `arrangement`,
 * `strictness`, `zones`, `lock`, `seed`, `time` — never from which element id
 * sits in a slot. So the canvas engine gets the FULL 9-slot list (with a
 * filler id in hosted slots, skipped via `drawOnly`), and the hosted quads
 * get a mask built by buildZoneMask() with the SAME comp/arrangement/
 * strictness/zones/lock/seed/time and an explicit `slots` list naming their
 * global position — both resolve to the identical partition independently.
 *
 * One canvas via paintLayered() (drawOnly + elemGain + layered, see
 * engine.ts), not one canvas per element — that already renders each element
 * to its own surface with a depth-ramped Atmosphere and composites, which is
 * exactly the semantics wanted. Depth for hosted elements uses the same
 * formula paintLayered() uses internally, computed here in JS.
 *
 * What does NOT work, on purpose: Heat/Push/pose reactivity is hosted-only —
 * the canvas engine has no heat input — so under Left/Right half the screen
 * can react to a dancer while the other half sits inert. Softness only
 * affects the canvas half. Recolour only affects the hosted half (the canvas
 * half already resolves colour through the Palette blend below; re-hueing it
 * again would just re-quantise correct colours).
 */

const ARRANGEMENTS = ['Chaotic', 'Left / Right', 'Up / Down'] as const;
const ARRANGEMENT_VALUES: ZoneInput['arrangement'][] = ['chaotic', 'leftRight', 'upDown'];

/** The five Canvas2D elements, in the fixed order they occupy slots 0..4 of
 *  the 9-slot Elements list. Slots 5..8 are the four SOURCES (hosted), in
 *  SOURCES' own order. */
const CANVAS_ELEMENTS: { id: ElementId; label: string; tip: string }[] = [
  { id: 1, label: 'Points', tip: 'Dots — either a jittered grid, chains along bent strands, or a flowing field.' },
  { id: 2, label: 'Lines', tip: 'Long bent strands of varying thickness.' },
  { id: 3, label: 'Mesh', tip: 'A net of nodes connected to their neighbours.' },
  { id: 4, label: 'Rings', tip: 'Concentric rings around an off-centre point.' },
  { id: 5, label: 'Gravity', tip: 'Short dashes aligned to a gravity field of a few attracting and repelling masses.' },
];
const N_SLOTS = CANVAS_ELEMENTS.length + SOURCES.length; // 9

const DEFAULT_SEED = 8420;
const TIME_RATE = 1.0;

/**
 * The hosted-element Order controls used to be labelled "<name> Order" (e.g.
 * "Particle Field Order"); the label is also the localStorage persistence key
 * (`pp:<patternId>:<label>`, see persist.ts), so dropping the suffix orphans
 * any value already saved under the old key. Carry it forward once, before
 * wrapWithPersist's own restore pass reads localStorage — leaves the old key
 * in place rather than deleting it, same as this project's other renames.
 */
function migrateOrderLabels(id: string) {
  for (const s of SOURCES) {
    const oldKey = `pp:${id}:${s.label} Order`;
    const newKey = `pp:${id}:${s.label}`;
    try {
      if (localStorage.getItem(newKey) === null) {
        const old = localStorage.getItem(oldKey);
        if (old !== null) localStorage.setItem(newKey, old);
      }
    } catch { /* localStorage unavailable — nothing to migrate */ }
  }
}

export function makeLustspielCombined(id: string, name: string, phase: PhaseId): Pattern {
  migrateOrderLabels(id);

  // ── Elements / Order ────────────────────────────────────────────────────────
  // order[i] = 0 (off) or its position among active elements (1-based, ties
  // broken by fixed slot index — stable and always resolvable, so it can
  // never reach an invalid combination).
  const order = new Array<number>(N_SLOTS).fill(0);
  order[0] = 1;               // Points
  order[5] = 2;                // Particle Field (SOURCES[0])

  function activeList(): number[] {
    return order
      .map((v, i) => ({ v, i }))
      .filter(e => e.v > 0)
      .sort((a, b) => a.v - b.v || a.i - b.i)
      .map(e => e.i);
  }

  // ── Canvas engine state ─────────────────────────────────────────────────────
  const state: EngineState = {
    phase,
    elems: [1],
    comp: 'blobs',
    arrangement: 'chaotic',
    pointStyle: 'strands',
    lineDir: 'v',
    dens: 1.4,
    stroke: 1,
    warp: 1,
    organic: 0.3,
    zones: 3,
    lock: 0.35,
    pk: 0,
    seed: DEFAULT_SEED,
    colorSoftness: 0.3,
    strictness: 0.65,
    time: 0,
    animated: true,
    atmosphere: 0,
    layered: true,       // always use paintLayered — needed for drawOnly/elemGain
  };
  let speed = 0.15;
  let compMode: 'merged' | 'bands' | 'blobs' = 'blobs';
  let maskEdge = 0.25;

  const canvasGain: Record<ElementId, number> = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 };
  const hostedGain: number[] = [...GAIN_DEFAULT];

  let paletteBlend = 0.5;
  let lastAppPaletteKey = '';
  let recolour = 0;
  let colourBlend = 0.5;
  const palColors = Array.from({ length: 5 }, () => new THREE.Color(1, 1, 1));

  function appPaletteKey(): string {
    return getEnabledIndices().map(getColorByIndex).join(',');
  }
  function applyPalette() {
    const filmPal = PHASE[phase].pal;
    const appColors = getEnabledIndices().map(getColorByIndex);
    const appPal = appColors.length >= filmPal.length
      ? appColors.slice(0, filmPal.length)
      : Array.from({ length: filmPal.length }, (_, i) => appColors[i % Math.max(1, appColors.length)] ?? '#ffffff');
    state.palette = filmPal.map((f, i) => mixHex(f, appPal[i], paletteBlend));
    for (let i = 0; i < filmPal.length; i++) palColors[i].set(mixHex(filmPal[i], appPal[i], paletteBlend));
  }

  // ── Canvas surface (CSS resolution — NOT pixelRatio, see class doc in the plan:
  // the app's own scene target is CSS-res, so a DPR-sized source is 4x the pixels
  // for a slightly worse image once minified back down). ──
  let canvas: HTMLCanvasElement | null = null;
  let c2d: CanvasRenderingContext2D | null = null;
  let texture: THREE.CanvasTexture | null = null;
  let mesh: THREE.Mesh | null = null;
  let material: THREE.ShaderMaterial | null = null;
  let geometry: THREE.PlaneGeometry | null = null;
  let dirty = true;
  const scheduler = createRepaintScheduler();

  const touch = () => { dirty = true; };

  function resizeCanvas(width: number, height: number) {
    if (!canvas) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    dirty = true;
  }

  function repaint() {
    if (!canvas || !c2d || !texture) return;
    const scale = canvas.width / DESIGN_W;
    const logicalH = canvas.height / scale;
    applyPalette();
    const active = activeList();
    state.elems = active.map(i => (i < 5 ? (CANVAS_ELEMENTS[i].id) : 1)) as ElementId[];
    state.drawOnly = active.map((i, slot) => (i < 5 ? slot : -1)).filter(s => s >= 0);
    state.elemGain = active.map(i => (i < 5 ? canvasGain[CANVAS_ELEMENTS[i].id] : 1));
    state.bypassZones = compMode === 'merged';
    paint(c2d, scale, logicalH, state);
    texture.needsUpdate = true;
    dirty = false;
  }

  // ── Hosted WebGL sources — same lifecycle as Lustspiel Particle, one scene/
  // camera/target/quad per SOURCE, always sharing the ONE canvas quad's zone
  // partition instead of a per-layer one. ──
  let renderer: THREE.WebGLRenderer | null = null;
  let size = { width: 1, height: 1 };
  const scenes: (THREE.Scene | null)[] = SOURCES.map(() => null);
  const cams: (THREE.PerspectiveCamera | null)[] = SOURCES.map(() => null);
  const started: boolean[] = SOURCES.map(() => false);
  const targets: (THREE.WebGLRenderTarget | null)[] = SOURCES.map(() => null);
  const quadMats: (THREE.ShaderMaterial | null)[] = SOURCES.map(() => null);
  const quadMeshes: (THREE.Mesh | null)[] = SOURCES.map(() => null);
  let quadGeo: THREE.PlaneGeometry | null = null;

  const MW = 24, MH = 14;
  const maskTex: (THREE.DataTexture | null)[] = SOURCES.map(() => null);
  const maskData: (Uint8Array<ArrayBuffer> | null)[] = SOURCES.map(() => null);

  function ensureSource(i: number) {
    if (started[i] || !renderer) return;
    const sc = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(60, size.width / Math.max(size.height, 1), 0.1, 100);
    cam.position.set(0, 0, 5);
    scenes[i] = sc; cams[i] = cam;
    SOURCES[i].pattern.init({ scene: sc, camera: cam, renderer, size });
    SOURCES[i].pattern.resize(size.width, size.height);
    started[i] = true;
  }
  function stopSource(i: number) {
    if (!started[i]) return;
    SOURCES[i].pattern.dispose();
    scenes[i] = null; cams[i] = null;
    targets[i]?.dispose(); targets[i] = null;
    started[i] = false;
  }
  function ensureTarget(i: number) {
    const w = Math.max(1, Math.round(size.width));
    const h = Math.max(1, Math.round(size.height));
    const t = targets[i];
    if (t && t.width === w && t.height === h) return t;
    t?.dispose();
    const nt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: true,
    });
    targets[i] = nt;
    return nt;
  }
  /** Same two-field grime mask as Lustspiel Particle, keyed by this source's
   *  global slot so no two elements dissolve in the same places. */
  function updateHostedMask(i: number, globalSlot: number) {
    if (!maskData[i]) {
      maskData[i] = new Uint8Array(new ArrayBuffer(MW * MH * 4));
      const tx = new THREE.DataTexture(maskData[i]!, MW, MH, THREE.RGBAFormat);
      tx.minFilter = THREE.LinearFilter;
      tx.magFilter = THREE.LinearFilter;
      tx.needsUpdate = true;
      maskTex[i] = tx;
    }
    const d = maskData[i]!;
    const t = state.time ?? 0;
    const H = DESIGN_W * (size.height / Math.max(size.width, 1));
    for (let my = 0; my < MH; my++) {
      for (let mx = 0; mx < MW; mx++) {
        const wx = ((mx + 0.5) / MW) * DESIGN_W, wy = (1 - (my + 0.5) / MH) * H;
        const a = field(wx * 0.55 + globalSlot * 210, wy * 0.55 + globalSlot * 130, state.seed + 500 + globalSlot * 97 + t * 0.3);
        const b = -field(wx * 0.45 + 300 + globalSlot * 170, wy * 0.45 + 300 + globalSlot * 90, state.seed + 640 + globalSlot * 61 + t * 0.3);
        const idx = (my * MW + mx) * 4;
        d[idx] = Math.round(Math.max(0, Math.min(1, a * 1.9)) * 255);
        d[idx + 1] = Math.round(Math.max(0, Math.min(1, b * 1.9)) * 255);
        d[idx + 2] = 0; d[idx + 3] = 255;
      }
    }
    maskTex[i]!.needsUpdate = true;
  }

  // ── Shared zone mask for the hosted quads ──────────────────────────────────
  const ZW = 160;
  let zoneW = ZW, zoneH = 90;
  let zoneData: Uint8Array<ArrayBuffer> | null = null;
  let zoneTex: THREE.DataTexture | null = null;
  let maskDirty = true;

  function rebuildZoneMask(active: number[]) {
    const logicalH = DESIGN_W * (size.height / Math.max(size.width, 1));
    const h = Math.max(8, Math.min(256, Math.round(ZW * logicalH / DESIGN_W)));
    if (!zoneData || zoneW !== ZW || zoneH !== h) {
      zoneW = ZW; zoneH = h;
      zoneData = new Uint8Array(new ArrayBuffer(zoneW * zoneH * 4));
      zoneTex?.dispose();
      const tx = new THREE.DataTexture(zoneData, zoneW, zoneH, THREE.RGBAFormat);
      tx.minFilter = THREE.LinearFilter;
      tx.magFilter = THREE.LinearFilter;
      zoneTex = tx;
    }
    const hostedSlots = active
      .map((i, slot) => (i >= 5 ? slot : -1))
      .filter(s => s >= 0);
    const input: ZoneInput = {
      elems: Array.from({ length: Math.max(1, active.length) }, () => 1 as ElementId),
      comp: state.comp,
      arrangement: state.arrangement, strictness: state.strictness,
      zones: state.zones, lock: state.lock, seed: state.seed, time: state.time,
    };
    buildZoneMask(zoneData!, zoneW, zoneH, logicalH, input, hostedSlots);
    zoneTex!.needsUpdate = true;
    maskDirty = false;
  }

  // ── Controls ────────────────────────────────────────────────────────────────
  function noCanvasElementActive(): boolean {
    return !activeList().some(i => i < 5);
  }

  const controls: PatternControl[] = [
    { label: 'Elements', type: 'separator' },
    ...CANVAS_ELEMENTS.map((e, i) => ({
      label: e.label, type: 'stepper' as const, min: 0, max: N_SLOTS,
      tip: `${e.tip} 0 = off, otherwise its position among the active elements (Left/Right and Up/Down honour this order).`,
      get: () => order[i], set: (v: number) => { order[i] = Math.round(v); touch(); maskDirty = true; },
    })),
    ...SOURCES.map((s, si) => {
      const i = CANVAS_ELEMENTS.length + si;
      return {
        label: s.label, type: 'stepper' as const, min: 0, max: N_SLOTS,
        tip: `${s.label} (hosted) — 0 = off, otherwise its position among the active elements. Its Heat / Push / pose reactivity works exactly as in the original pattern.`,
        get: () => order[i],
        set: (v: number) => {
          const next = Math.round(v);
          order[i] = next;
          touch(); maskDirty = true;
          if (next > 0) ensureSource(si); else stopSource(si);
        },
      };
    }),

    { label: 'Composition', type: 'separator' },
    { label: 'Zone Shape', type: 'buttons', options: ['Merged', 'Bands', 'Blobs'],
      tip: 'Merged: no mask at all — every element covers the whole screen and they stack on top of each other. Bands / Blobs: the screen is divided between the elements, like a layer mask.',
      disabled: () => activeList().length < 2,
      get: () => (compMode === 'merged' ? 0 : compMode === 'bands' ? 1 : 2),
      set: (v: number) => { compMode = v === 0 ? 'merged' : v === 1 ? 'bands' : 'blobs'; if (compMode !== 'merged') state.comp = compMode; touch(); maskDirty = true; } },
    { label: 'Arrangement', type: 'buttons', options: [...ARRANGEMENTS],
      tip: 'Chaotic scatters the zones over the whole surface. Left/Right and Up/Down give each element its own side, in Order.',
      disabled: () => activeList().length < 2 || compMode === 'merged',
      get: () => ARRANGEMENT_VALUES.indexOf(state.arrangement),
      set: (v: number) => { state.arrangement = ARRANGEMENT_VALUES[v] ?? 'chaotic'; touch(); maskDirty = true; } },
    { label: 'Strictness', type: 'range', min: 0, max: 1, step: 0.01, default: 0.65,
      tip: 'Only for Left/Right and Up/Down: how unambiguous the split is.',
      disabled: () => activeList().length < 2 || compMode === 'merged' || state.arrangement === 'chaotic',
      get: () => state.strictness, set: (v: number) => { state.strictness = v; touch(); maskDirty = true; } },
    { label: 'Zones', type: 'range', min: 2, max: 6, step: 1, default: 3,
      tip: 'Blobs: how many clusters each element gets. Bands: only affects Chaotic.',
      disabled: () => activeList().length < 2 || compMode === 'merged' || (state.comp === 'bands' && state.arrangement !== 'chaotic'),
      get: () => state.zones, set: (v: number) => { state.zones = Math.round(v); touch(); maskDirty = true; } },
    { label: 'Interlock', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35,
      tip: 'How much neighbouring zones reach into each other at their edge.',
      disabled: () => activeList().length < 2 || compMode === 'merged',
      get: () => state.lock, set: (v: number) => { state.lock = v; touch(); maskDirty = true; } },
    { label: 'Mask Edge', type: 'range', min: 0, max: 1, step: 0.01, default: 0.25,
      tip: 'Hosted elements only: how hard the boundary is. 0 crisp, 1 a wide feather. The canvas half always uses Interlock for its own seam.',
      disabled: () => activeList().length < 2 || compMode === 'merged',
      get: () => maskEdge, set: (v: number) => { maskEdge = v; } },

    { label: 'Motion', type: 'separator' },
    { label: 'Speed', type: 'range', min: 0, max: 2, step: 0.01, default: 0.15,
      tip: '0 holds everything still. Higher values let it slowly drift.',
      get: () => speed, set: (v: number) => { speed = v; touch(); } },
    { label: 'Atmosphere', type: 'range', min: 0, max: 1, step: 0.01, default: 0,
      tip: 'Uneven grime with depth: elements further back in Order dissolve into a wash of colour or sink toward black at their border, so depth reads as elements sliding under one another.',
      get: () => state.atmosphere ?? 0, set: (v: number) => { state.atmosphere = v; touch(); } },

    { label: 'Colour', type: 'separator' },
    { label: 'Palette', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5,
      tip: 'Left: Film — this phase’s fixed colours. Right: Default — the app’s global colour palette, changeable live.',
      get: () => paletteBlend, set: (v: number) => { paletteBlend = v; touch(); } },
    { label: 'Colour Blend', type: 'range', min: 0, max: 1, step: 0.01, default: 0.4,
      tip: 'Hard (0): each shape / hosted pixel picks one stepped palette colour. Soft (1): a smooth gradient.',
      get: () => colourBlend, set: (v: number) => { colourBlend = v; state.colorSoftness = v; touch(); } },
    { label: 'Recolour', type: 'range', min: 0, max: 1, step: 0.01, default: 0,
      tip: 'Hosted elements only — re-colours them onto the palette above. The canvas elements already resolve their colour through Palette/Colour Blend, so Recolour never touches them.',
      get: () => recolour, set: (v: number) => { recolour = v; } },

    { label: 'Identity', type: 'separator' },
    { label: 'Seed', type: 'stepper', min: 1, max: 9999, step: 1,
      tip: 'Picks one specific pattern and atmosphere layout. The same seed always gives the same image.',
      get: () => state.seed, set: (v: number) => { state.seed = Math.round(v); touch(); maskDirty = true; } },
    { label: 'New Seed', type: 'button', tip: 'Roll a new seed.',
      action: () => { state.seed = 1 + Math.floor(Math.random() * 9999); touch(); maskDirty = true; } },

    { label: 'Canvas Shape', type: 'section', collapsible: true, get: () => true, set: () => {} },
    { label: 'Density', type: 'range', min: 0.4, max: 2.4, step: 0.01, default: 1.4,
      tip: 'How closely the canvas strands, dots or rings sit together.',
      disabled: noCanvasElementActive,
      get: () => state.dens, set: (v: number) => { state.dens = v; touch(); } },
    { label: 'Stroke Width', type: 'range', min: 0.5, max: 1.5, step: 0.01, default: 1,
      tip: 'Thickness of every canvas mark.',
      disabled: noCanvasElementActive,
      get: () => state.stroke, set: (v: number) => { state.stroke = v; touch(); } },
    { label: 'Warp', type: 'range', min: 0, max: 2.5, step: 0.01, default: 1,
      tip: 'How strongly the canvas strands bend away from a straight path.',
      disabled: noCanvasElementActive,
      get: () => state.warp, set: (v: number) => { state.warp = v; touch(); } },
    { label: 'Organic', type: 'range', min: 0, max: 1, step: 0.01, default: 0.3,
      tip: 'From regular waves to a wild, irregular, vine-like meander.',
      disabled: noCanvasElementActive,
      get: () => state.organic, set: (v: number) => { state.organic = v; touch(); } },
    { label: 'Softness', type: 'range', min: 0, max: 1, step: 0.01, default: 0,
      tip: 'Canvas elements only: blurred and semi-transparent instead of crisp.',
      disabled: noCanvasElementActive,
      get: () => state.softness ?? 0, set: (v: number) => { state.softness = v; touch(); } },
    { label: 'Point Style', type: 'buttons', options: ['Grid', 'Strands', 'Wave'],
      disabled: () => order[0] <= 0,
      get: () => ['grid', 'strands', 'wave'].indexOf(state.pointStyle),
      set: (v: number) => { state.pointStyle = (['grid', 'strands', 'wave'] as const)[v] ?? 'strands'; touch(); } },
    { label: 'Line Direction', type: 'buttons', options: ['Vertical', 'Horizontal'],
      disabled: () => order[1] <= 0 && !(order[0] > 0 && state.pointStyle !== 'grid'),
      get: () => (state.lineDir === 'v' ? 0 : 1),
      set: (v: number) => { state.lineDir = v === 0 ? 'v' : 'h'; touch(); } },
    { label: 'Thinning', type: 'range', min: 0, max: 60, step: 1, default: 0,
      tip: 'Removes canvas elements — fewer marks, not a dimmer image.',
      disabled: noCanvasElementActive,
      get: () => state.pk, set: (v: number) => { state.pk = Math.round(v); touch(); } },

    { label: 'Balance', type: 'section', collapsible: true, get: () => true, set: () => {} },
    ...CANVAS_ELEMENTS.map(e => ({
      label: `${e.label} Bright`, type: 'range' as const, min: 0, max: 1, step: 0.01, default: 1,
      tip: `How strongly ${e.label} reads next to the other elements.`,
      disabled: () => order[CANVAS_ELEMENTS.indexOf(e)] <= 0,
      get: () => canvasGain[e.id], set: (v: number) => { canvasGain[e.id] = v; touch(); },
    })),
    ...SOURCES.map((s, si) => ({
      label: `${s.label} Bright`, type: 'range' as const, min: 0, max: 1, step: 0.01, default: GAIN_DEFAULT[si],
      tip: `How strongly ${s.label} reads next to the other elements.`,
      disabled: () => order[CANVAS_ELEMENTS.length + si] <= 0,
      get: () => hostedGain[si], set: (v: number) => { hostedGain[si] = v; },
    })),
    ...SOURCES.filter(s => s.id === 'particlesHeat' || s.id === 'hyperMixHeat').map(s => {
      const si = SOURCES.indexOf(s);
      const fillCtrl = () => s.pattern.controls?.find(
        (c): c is Extract<PatternControl, { type: 'range' }> => c.type === 'range' && c.label === 'Fill'
      );
      return {
        label: `${s.label} Fill`, type: 'range' as const, min: 0, max: 1, step: 0.05, default: 0,
        tip: `Fills in ${s.label}'s dark holes — spreads it toward the frame's edges and corners.`,
        disabled: () => order[CANVAS_ELEMENTS.length + si] <= 0,
        get: () => fillCtrl()?.get() ?? 0,
        set: (v: number) => fillCtrl()?.set(v),
      };
    }),

    { label: 'Hosted Presets', type: 'section', collapsible: true, get: () => true, set: () => {} },
    ...[0, 1, 2].map(i => ({
      label: `Load Preset ${i + 1}`, type: 'button' as const,
      tip: `Loads slot ${i + 1} of each active hosted element from that pattern's own saved presets.`,
      action: () => {
        for (let si = 0; si < SOURCES.length; si++) {
          if (order[CANVAS_ELEMENTS.length + si] <= 0) continue;
          const snap = getSlots(SOURCES[si].id)[i];
          if (!snap) continue;
          for (const ctrl of SOURCES[si].pattern.controls ?? []) {
            if (ctrl.type === 'button' || ctrl.type === 'separator' || ctrl.type === 'section') continue;
            const v = snap[ctrl.label];
            if (v === undefined) continue;
            try { (ctrl.set as (x: unknown) => void)(v); } catch { /* control rejects it — skip */ }
          }
        }
      },
    })),

    { label: 'All Phases', type: 'section', collapsible: true, get: () => true, set: () => {} },
    { label: 'Apply to all Lustspiel patterns', type: 'button',
      tip: 'Copies these settings onto the other Lustspiel phases, so you only have to dial them in once.',
      action: () => { void applyToAllLustspiel(id); } },
  ];

  return {
    id,
    name,
    motionControlLabels: ['Speed', 'Organic'],
    audioControlLabels: ['Speed'],
    heatReactive: true,
    controls,

    init(ctx: PatternContext) {
      renderer = ctx.renderer;
      size = { width: ctx.size.width, height: ctx.size.height };

      canvas = document.createElement('canvas');
      c2d = canvas.getContext('2d');
      resizeCanvas(ctx.size.width, ctx.size.height);
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      geometry = new THREE.PlaneGeometry(2, 2);
      material = new THREE.ShaderMaterial({
        uniforms: { uTexture: { value: texture } },
        vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: /* glsl */`precision highp float; uniform sampler2D uTexture; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(uTexture, vUv).rgb, 1.0); }`,
        depthTest: false, depthWrite: false,
      });
      mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = -1;   // canvas is the front-most family; draw first so hosted additive quads layer on top
      ctx.scene.add(mesh);

      quadGeo = new THREE.PlaneGeometry(2, 2);
      for (let si = 0; si < SOURCES.length; si++) {
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uTex: { value: null }, uMask: { value: null }, uZone: { value: null },
            uSlotSel: { value: new THREE.Vector4(1, 0, 0, 0) },
            uZoneOn: { value: 0 }, uEdge: { value: 0.25 }, uGain: { value: 1 },
            uPal: { value: palColors }, uRecolour: { value: 0 }, uColBlend: { value: 0.5 },
            uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
            uAtmo: { value: 0 }, uWarp: { value: 0 }, uTime: { value: 0 },
          },
          vertexShader: compositeVert, fragmentShader: compositeFrag,
          depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
        });
        const qm = new THREE.Mesh(quadGeo, mat);
        qm.frustumCulled = false; qm.visible = false;
        quadMats[si] = mat; quadMeshes[si] = qm;
        ctx.scene.add(qm);
      }

      for (let si = 0; si < SOURCES.length; si++) if (order[CANVAS_ELEMENTS.length + si] > 0) ensureSource(si);
      lastAppPaletteKey = appPaletteKey();
      repaint();
    },

    update(dt: number, elapsed: number) {
      if (!renderer) return;
      const active = activeList();
      const n = active.length;

      if (speed > 0) touch();
      if (paletteBlend >= 0) {
        const key = appPaletteKey();
        if (key !== lastAppPaletteKey) { lastAppPaletteKey = key; touch(); }
      }
      if (maskDirty && compMode !== 'merged' && n > 1) rebuildZoneMask(active);

      if (scheduler.shouldRepaint(dt, dirty)) {
        if (speed > 0) {
          // Advance by the real (capped) time since the last repaint, not
          // this frame's dt — a throttled repaint is "catching up" on
          // several frames at once, and capping it here (see
          // repaintScheduler.ts) is what keeps that catch-up from reading
          // as a single oversized jump.
          state.time = (state.time ?? 0) + scheduler.consumeStep() * speed * TIME_RATE;
        }
        resizeCanvas(size.width, size.height);
        const t0 = performance.now();
        repaint();
        scheduler.reportCost(performance.now() - t0);
      }

      // Dual speed calibration: canvas time above already scales by 0.15-ish
      // TIME_RATE; the hosted patterns ignore elapsed entirely and rely on
      // dt-scaling, but each also drives its own Heat/Push field internally —
      // Speed 0 must not fully freeze that, so it never drops below a quarter
      // rate.
      const webglSpeed = 0.25 + 0.75 * Math.min(1, speed);

      for (let si = 0; si < SOURCES.length; si++) if (quadMeshes[si]) quadMeshes[si]!.visible = false;

      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      for (let si = 0; si < SOURCES.length; si++) {
        if (!started[si] || !scenes[si] || !cams[si]) continue;
        const rt = ensureTarget(si);
        renderer.setRenderTarget(rt);
        renderer.autoClear = true;
        renderer.clear(true, true, true);
        SOURCES[si].pattern.update(dt * webglSpeed, elapsed);
        renderer.render(scenes[si]!, cams[si]!);
      }
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;

      const useMask = compMode !== 'merged' && n > 1;
      const atmo = state.atmosphere ?? 0;
      for (let si = 0; si < SOURCES.length; si++) {
        const qm = quadMeshes[si], mat = quadMats[si], rt = targets[si];
        const globalSlot = active.indexOf(CANVAS_ELEMENTS.length + si);
        const on = globalSlot >= 0 && started[si] && !!rt;
        if (!qm || !mat) continue;
        qm.visible = on;
        if (!on) continue;
        updateHostedMask(si, globalSlot);
        const chanIdx = useMask
          ? active.filter(i => i >= 5).indexOf(CANVAS_ELEMENTS.length + si)
          : -1;
        mat.uniforms.uTex.value = rt!.texture;
        mat.uniforms.uMask.value = maskTex[si];
        mat.uniforms.uZone.value = zoneTex;
        (mat.uniforms.uSlotSel.value as THREE.Vector4).set(
          chanIdx === 0 ? 1 : 0, chanIdx === 1 ? 1 : 0, chanIdx === 2 ? 1 : 0, chanIdx === 3 ? 1 : 0);
        mat.uniforms.uZoneOn.value = useMask && zoneTex ? 1 : 0;
        mat.uniforms.uEdge.value = maskEdge;
        mat.uniforms.uGain.value = hostedGain[si];
        mat.uniforms.uRecolour.value = recolour;
        mat.uniforms.uColBlend.value = colourBlend;
        (mat.uniforms.uTexel.value as THREE.Vector2).set(1 / rt!.width, 1 / rt!.height);
        // Same depth ramp paintLayered() uses internally for the canvas half —
        // slot 0 (frontmost) is exempt, everything behind gets progressively
        // more atmosphere.
        mat.uniforms.uAtmo.value = globalSlot === 0 ? 0 : atmo * (0.45 + 0.55 * (n > 1 ? globalSlot / (n - 1) : 0));
        mat.uniforms.uWarp.value = 0;
        mat.uniforms.uTime.value = state.time ?? 0;
        qm.renderOrder = N_SLOTS - globalSlot;
      }
    },

    resize(width: number, height: number) {
      size = { width, height };
      resizeCanvas(width, height);
      for (let si = 0; si < SOURCES.length; si++) {
        if (!started[si] || !cams[si]) continue;
        cams[si]!.aspect = width / Math.max(height, 1);
        cams[si]!.updateProjectionMatrix();
        SOURCES[si].pattern.resize(width, height);
      }
      for (let si = 0; si < SOURCES.length; si++) if (targets[si]) ensureTarget(si);
      maskDirty = true;
      touch();
    },

    dispose() {
      geometry?.dispose(); material?.dispose(); texture?.dispose();
      mesh = null; geometry = null; material = null; texture = null;
      canvas = null; c2d = null;
      for (let si = 0; si < SOURCES.length; si++) stopSource(si);
      for (let si = 0; si < SOURCES.length; si++) { targets[si]?.dispose(); targets[si] = null; }
      for (let si = 0; si < SOURCES.length; si++) { maskTex[si]?.dispose(); maskTex[si] = null; maskData[si] = null; }
      zoneTex?.dispose(); zoneTex = null; zoneData = null;
      quadGeo?.dispose(); quadGeo = null;
      for (let si = 0; si < SOURCES.length; si++) { quadMats[si]?.dispose(); quadMats[si] = null; quadMeshes[si] = null; }
      renderer = null;
    },
  };
}

/** Same convention as lustspielPattern.ts's applyToAll: copies control values
 *  by label onto every other `lsp-*` pattern's persistence keys. Duplicated
 *  rather than shared to avoid coupling the two factories together. */
async function applyToAllLustspiel(sourceId: string) {
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
      try { localStorage.setItem(`pp:${t.id}:${ctrl.label}`, raw); } catch { /* ignore */ }
    }
  }
  restoreFromKeys(targets);
}
