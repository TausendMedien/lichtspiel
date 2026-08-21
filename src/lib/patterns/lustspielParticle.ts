import * as THREE from 'three';
import type { Pattern, PatternContext, PatternControl } from './types';
import { hyperMixHeat } from './hyperMixHeat';
import { particlesHeat } from './particlesHeat';
import { gravityLines } from './gravityLines';
import { parallelLinesStraight } from './parallelLinesStraight';
import { getSlots } from '../presets';
import { field, DESIGN_W, buildZoneMask, PHASE, mixHex, type ZoneInput } from '../pattern-engine/engine';
import { getEnabledIndices, getColorByIndex } from '../colorC2.svelte';
import type { ElementId } from '../pattern-engine/types';

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

const ARRANGEMENTS = ['Chaotic', 'Left / Right', 'Up / Down'] as const;
const ARRANGEMENT_VALUES: ZoneInput['arrangement'][] = ['chaotic', 'leftRight', 'upDown'];

const MAX_LAYERS = 4;

/**
 * Starting output gain per element, so the four hosted patterns land in roughly
 * the same brightness range instead of whichever is densest dominating. These
 * are only a starting point: each element also gets its own Brightness slider,
 * because the four hosted patterns have their own controls (and their own
 * presets) that move their brightness by large factors — any constant fitted
 * once here would drift out of calibration as soon as those are touched.
 * Values are <= 1: gains above 1 clip in the UNORM8 target, and clipping is not
 * recoverable by the post pass. Indices follow SOURCES below.
 */
const GAIN_DEFAULT = [0.75, 0.85, 1, 1];

interface Source {
  id: string;
  label: string;
  pattern: Pattern;
}

// Order matters twice over: it is the order the controls are listed in, and it
// is the order zone slots are handed out in (slot = position among the enabled
// sources). GAIN_DEFAULT above follows the same order.
const SOURCES: Source[] = [
  { id: 'particlesHeat', label: 'Particle Field', pattern: particlesHeat },
  { id: 'gravityLines', label: 'Gravity Lines', pattern: gravityLines },
  { id: 'hyperMixHeat', label: 'Hyper Mix', pattern: hyperMixHeat },
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
  uniform sampler2D uMask;     // atmosphere: r = dissolve-into-wash, g = sink-into-dark
  uniform sampler2D uZone;     // composition: one channel per element slot
  uniform vec4  uSlotSel;      // picks this element's channel out of uZone
  uniform float uZoneOn;       // 0 = Merged (no mask at all), 1 = masked
  uniform float uEdge;         // 0 = crisp mask edge, 1 = feathered
  uniform vec2  uTexel;
  uniform float uAtmo;
  uniform float uWarp;
  uniform float uTime;
  uniform float uGain;
  uniform vec3  uPal[5];
  uniform float uRecolour;   // 0 = each element's own colours, 1 = fully re-mapped
  uniform float uColBlend;   // 0 = hard stepped palette, 1 = smooth gradient
  varying vec2 vUv;

  // Hard pick: the palette bucket pos falls into. Loop indices are
  // constant-index-expressions, so indexing uPal[i] here is legal GLSL ES 1.0.
  vec3 palHard(float pos) {
    vec3 c = uPal[0];
    for (int i = 1; i < 5; i++) c = mix(c, uPal[i], step(float(i), pos));
    return c;
  }
  // Hue in 0..1, plus chroma. Used as the palette ramp position, see below.
  vec4 hueChroma(vec3 c) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float d  = mx - mn;
    float h  = 0.0;
    if (d > 1e-4) {
      if (mx == c.r)      h = mod((c.g - c.b) / d, 6.0);
      else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
      else                h = (c.r - c.g) / d + 4.0;
      h /= 6.0;
    }
    return vec4(h, d, mx, 0.0);
  }
  // Smooth: piecewise-linear ramp across neighbouring entries.
  vec3 palSoft(float pos) {
    vec3 c = uPal[0];
    for (int i = 1; i < 5; i++) c = mix(c, uPal[i], clamp(pos - float(i) + 1.0, 0.0, 1.0));
    return c;
  }

  void main() {
    // Composition mask first, sampled at the UNWARPED vUv so Warp bends the
    // content *inside* a zone that stays put — Photoshop-mask behaviour.
    float zone = 1.0;
    float rawZone = 1.0;
    if (uZoneOn > 0.5) {
      float raw = dot(texture2D(uZone, vUv), uSlotSel);
      rawZone = raw;
      // The mask is 2x2 supersampled, so edges arrive as a ramp. uEdge turns
      // that ramp into anything from a hard cut to a wide feather.
      float e = max(uEdge * 0.5, 0.002);
      zone = smoothstep(0.5 - e, 0.5 + e, raw);
      // Bail before the warp and the 9-tap blur below. With N elements each
      // owning ~1/N of the screen this is what keeps N composite passes costing
      // about one screen's worth of fill instead of N.
      if (zone < 0.002) discard;
    }

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
    // Atmosphere is a BORDER effect, not a global blur: both halves below share
    // one falloff, edge, that is 1 at the boundary between zones and fades to
    // 0 deep inside an element's own zone. width — how far in from the border
    // it reaches — grows with the Atmosphere amount, so raising the slider makes
    // the affected band deeper without ever touching the element's interior.
    // Merged has no neighbour to fade under, so edge is pinned to 1 there and
    // the wash/dark stay the gentle, frame-wide patchiness they were before.
    float atmoAmt = clamp(uAtmo, 0.0, 1.0);
    float width   = mix(0.06, 0.35, atmoAmt);
    float edge    = uZoneOn > 0.5 ? (1.0 - smoothstep(0.5, 0.5 + width, rawZone)) : 1.0;

    if (m.r > 0.001) {
      // The "dissolve into a wash of colour" half, as a coarse mip fetch.
      //
      // This used to be a 3x3 box blur with taps 14 texels apart. On dense
      // content that passes for a wash, but on a sparse point field like
      // Particle Field it is not a blur at all — each dot simply gets copied to
      // 9 places, and because every dot lands on the same offsets the copies
      // line up into a visible regular grid across the whole frame. A mip level
      // is a real, correctly filtered average, so sparse and dense elements
      // both dissolve the same way and nothing is replicated. LOD is kept
      // modest (1..3, not 3..6.5) so the wash reads as a soft dissolve rather
      // than a near-solid blur, and it is scaled by edge so it only shows up
      // at the border — same rule as the darkening below.
      float lod = mix(1.0, 3.0, clamp(m.r, 0.0, 1.0));
      vec3 w = texture2D(uTex, uv, lod).rgb;
      outc = mix(outc, w, clamp(m.r, 0.0, 1.0) * edge);
    }
    // The "sink into darkness" half. Capped below 1 so the element never
    // disappears entirely — Merged mode has no neighbour to slide under, so it
    // gets the tighter cap.
    float darkCap  = uZoneOn > 0.5 ? 0.88 : 0.5;
    outc *= (1.0 - clamp(m.g, 0.0, 1.0) * edge * darkCap);

    // Palette: a luminance gradient map. These hosted patterns colour themselves
    // per particle, so there is no per-shape colour index to reinterpret the way
    // the Canvas engine's col() does — brightness is the one signal every element
    // shares, which makes it the natural ramp position. The mapped colour is
    // rescaled to the ORIGINAL luminance, so re-hueing never changes how bright
    // the element reads on a body.
    if (uRecolour > 0.001) {
      // Swap the HUE, keep the BRIGHTNESS. The previous version matched Rec709
      // luminance instead, which looks right on paper but darkened the picture:
      // rescaling a dark, saturated palette entry up to the source luminance
      // pushes channels past 1.0, and the clamp that follows throws that excess
      // away — so the result lands *below* the luminance it was aiming for, and
      // the more saturated the palette, the worse it gets.
      //
      // Matching value (max channel) instead is clip-free by construction: the
      // palette colour is normalised to peak 1.0 and then multiplied by the
      // source's own peak, so the output peaks at exactly the same level the
      // input did. Colours change, brightness does not.
      vec4 hc = hueChroma(outc);
      float v = hc.z;                      // value = max channel
      // Ramp position comes from HUE, not brightness. These elements are
      // light-on-black, so nearly every lit pixel sits near peak value — a
      // brightness ramp sent them all to the same palette entry and the whole
      // element collapsed to one colour. Hue actually varies across the
      // particles, so hue is what carries "which colour is this".
      float pos = clamp(hc.x, 0.0, 0.9999) * 5.0;
      vec3 pc = mix(palHard(pos), palSoft(pos), uColBlend);
      // Normalise the palette entry to peak 1 and rescale to the SOURCE's own
      // peak, so the output peaks exactly where the input did. Brightness is
      // therefore independent of how dark or light the palette entry happens to
      // be, and nothing can clip.
      vec3 pcN = pc / max(max(pc.r, max(pc.g, pc.b)), 0.001);
      // Near-grey pixels have no meaningful hue, so leave them their neutral
      // tone instead of forcing them onto an arbitrary palette entry — that is
      // what keeps white highlights white.
      float amt = uRecolour * smoothstep(0.03, 0.20, hc.y);
      outc = mix(outc, pcN * v, amt);
    }

    // Masking is an rgb multiply with alpha pinned at 1.0, NOT an alpha encode.
    // Under AdditiveBlending (SRC_ALPHA, ONE) the colour result is identical, but
    // alpha-encoding would make A_dst = A_src^2 + A_dst and would double-count if
    // this ever moved to normal blending.
    gl_FragColor = vec4(outc * uGain * zone, 1.0);
  }
`;

// ─── Pattern ──────────────────────────────────────────────────────────────────

export function makeLustspielParticle(id: string, name: string): Pattern {
  /** Layer index per source, or -1 for off. Default: only Particle Field (the
   *  first source), on layer 1. */
  const assign: number[] = [0, -1, -1, -1];
  let layerCount = 1;

  const speed: number[] = [1, 1, 1, 1];
  const atmo: number[] = [0, 0.5, 0.65, 0.75];
  const warp: number[] = [0, 0, 0, 0];
  const layerTime: number[] = [0, 0, 0, 0];
  const gain: number[] = [...GAIN_DEFAULT];

  let seed = 4271;

  // Colour. Same two controls as the Canvas Lustspiel patterns: Palette blends
  // the target palette from Film (the Lustspiel phase colours) to Default (the
  // app's global palette), Colour Blend goes hard-stepped to smooth. Recolour is
  // the master amount, and it defaults to FULL with Palette on Film — the film
  // colours are the intended base for these elements too, and turning Recolour
  // down is how you get back to each element's own original colours.
  let paletteBlend = 0;
  let colourBlend = 0.5;
  let recolour = 1;
  const palColors = Array.from({ length: 5 }, () => new THREE.Color(1, 1, 1));

  /** Film palette x app palette, per entry — identical to lustspielPattern's
   *  applyPalette(). Phase B is the reference: white / cyan / magenta / violet,
   *  the same colour world these patterns already live in. */
  function updatePalette() {
    const filmPal = PHASE.B.pal;
    const appColors = getEnabledIndices().map(getColorByIndex);
    const appPal = appColors.length >= filmPal.length
      ? appColors.slice(0, filmPal.length)
      : Array.from({ length: filmPal.length }, (_, i) => appColors[i % Math.max(1, appColors.length)] ?? '#ffffff');
    // Left in the palette's authored order. Sorting by brightness would be
    // pointless here — the shader normalises every entry to peak 1 and rescales
    // it to the source pixel's own peak, so an entry's own lightness never
    // reaches the output — and it would scramble the sequence the palette was
    // designed in, which is what the hue ramp walks along.
    for (let i = 0; i < filmPal.length; i++) {
      palColors[i].set(mixHex(filmPal[i], appPal[i], paletteBlend));
    }
  }

  // ── Composition: all ENABLED elements share ONE zone partition, regardless of
  // which layer they sit on — "as if they were all on one layer". Layers only
  // control stacking, Speed, Atmosphere and Warp; the composition decides who
  // owns which part of the screen.
  let comp: 'merged' | 'bands' | 'blobs' = 'blobs';
  let arrangement: ZoneInput['arrangement'] = 'chaotic';
  let strictness = 0.65;
  let zones = 3;
  let lock = 0.35;
  let maskEdge = 0.25;
  let compTime = 0;
  let maskDirty = true;
  let lastMaskBuild = -1e9;

  const ZW = 160;
  let zoneW = ZW, zoneH = 90;
  let zoneData: Uint8Array<ArrayBuffer> | null = null;
  let zoneTex: THREE.DataTexture | null = null;

  let renderer: THREE.WebGLRenderer | null = null;
  let size = { width: 1, height: 1 };
  let pixelRatio = 1;

  /** One hosted scene per source, created lazily when it is first switched on. */
  const scenes: (THREE.Scene | null)[] = [null, null, null, null];
  const cams: (THREE.PerspectiveCamera | null)[] = [null, null, null, null];
  const started: boolean[] = [false, false, false, false];

  /** Per SOURCE, not per layer: each element needs its own surface so it can be
   *  masked to its zone and gain-balanced independently. This also fixes a
   *  latent bug — the old per-layer target never cleared depth between sources,
   *  so two unrelated hosted scenes depth-tested against each other. */
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
    targets[i]?.dispose(); targets[i] = null;
    started[i] = false;
  }

  function ensureTarget(l: number) {
    // Deliberately NOT multiplied by pixelRatio. renderer.setSize(w, h, false)
    // makes the canvas w*DPR, but the app's own scene target is rt.setSize(w, h)
    // — CSS resolution (renderer.ts applySize). A DPR-sized source target would
    // be bilinearly *minified* into it: 4x the memory for a slightly worse
    // image (~166 MB -> ~41 MB for four targets at DPR 2).
    const w = Math.max(1, Math.round(size.width));
    const h = Math.max(1, Math.round(size.height));
    const t = targets[l];
    if (t && t.width === w && t.height === h) return t;
    t?.dispose();
    const nt = new THREE.WebGLRenderTarget(w, h, {
      // Mipmapped so the Atmosphere wash can sample a genuinely low-frequency
      // level instead of faking a blur from a handful of wide taps (see the
      // shader). three regenerates these on setRenderTarget when the texture
      // asks for them.
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
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
        // Bottom-up rows: DataTexture.flipY is false and PlaneGeometry puts
        // uv.y = 1 at the top, so texel row 0 is the BOTTOM of the screen.
        const wx = ((mx + 0.5) / MW) * DESIGN_W, wy = (1 - (my + 0.5) / MH) * H;
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

  /** Source index -> zone slot, for the enabled sources in fixed SOURCES order. */
  function slotOf(i: number): number {
    if (assign[i] < 0) return -1;
    let slot = 0;
    for (let k = 0; k < i; k++) if (assign[k] >= 0) slot++;
    return slot;
  }
  const enabledCount = () => assign.reduce((n, a) => n + (a >= 0 ? 1 : 0), 0);
  const masked = () => comp !== 'merged' && enabledCount() > 1;

  /** Bands drift with time; blobs are completely static (blobCenters is cached
   *  without time and blobZone never reads it), so only bands need a timer.
   *  lock > 0 matters too: bandZone's seam dither reads field(..., seed+5+t) in
   *  every band arrangement. */
  const zoneNeedsTimer = () =>
    comp === 'bands' && (arrangement === 'chaotic' || strictness < 1 || lock > 0);

  function rebuildZoneMask() {
    const n = enabledCount();
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
    const input: ZoneInput = {
      // Only the LENGTH matters to the zone maths — the ids themselves are never
      // read, so a run of 1s standing for "n enabled elements" is enough.
      elems: Array.from({ length: Math.max(1, n) }, () => 1 as ElementId),
      comp: comp === 'bands' ? 'bands' : 'blobs',
      arrangement, strictness, zones, lock, seed, time: compTime,
    };
    buildZoneMask(zoneData!, zoneW, zoneH, logicalH, input);
    zoneTex!.needsUpdate = true;
    maskDirty = false;
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
        maskDirty = true;   // the enabled set defines the zone partition
        if (next < 0) stopSource(i); else ensureSource(i);
      },
    })),

    // Per-element brightness. Deliberately user-facing rather than a fitted
    // constant: these four patterns each have their own controls and presets
    // that shift their output a long way, so this has to stay tunable.
    ...SOURCES.map((s, i) => ({
      label: `${s.label} Bright`, type: 'range' as const, min: 0, max: 1, step: 0.01,
      default: GAIN_DEFAULT[i],
      tip: `How strongly ${s.label} reads next to the other elements. Lower it if it swamps them.`,
      disabled: () => assign[i] < 0,
      get: () => gain[i], set: (v: number) => { gain[i] = v; },
    })),

    // Fill — only Particle Field and Hyper Mix have this control on the hosted
    // pattern itself (see particlesHeat.ts / hyperMixHeat.ts); proxy straight
    // through to it rather than duplicating the state here.
    ...SOURCES.filter(s => s.id === 'particlesHeat' || s.id === 'hyperMixHeat').map(s => {
      const i = SOURCES.indexOf(s);
      const fillCtrl = () => s.pattern.controls?.find(
        (c): c is Extract<PatternControl, { type: 'range' }> => c.type === 'range' && c.label === 'Fill'
      );
      return {
        label: `${s.label} Fill`, type: 'range' as const, min: 0, max: 1, step: 0.05, default: 0,
        tip: `Fills in ${s.label}'s dark holes — spreads it toward the frame's edges and corners instead of a centred, hollow shape.`,
        disabled: () => assign[i] < 0,
        get: () => fillCtrl()?.get() ?? 0,
        set: (v: number) => fillCtrl()?.set(v),
      };
    }),

    { label: 'Identity', type: 'separator' },
    { label: 'Seed', type: 'stepper', min: 1, max: 9999, step: 1,
      tip: 'Picks the atmosphere patch layout. The same seed always gives the same grime.',
      get: () => seed, set: (v: number) => { seed = Math.round(v); maskDirty = true; } },
    { label: 'New Seed', type: 'button', tip: 'Roll a new atmosphere layout.',
      action: () => { seed = 1 + Math.floor(Math.random() * 9999); maskDirty = true; } },

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

    // ── Composition — who owns which part of the screen ───────────────────────
    // Independent of layers: every enabled element takes part in ONE partition,
    // whichever layer it sits on. Layers stack; composition divides.
    { label: 'Composition', type: 'separator' },
    { label: 'Zone Shape', type: 'buttons', options: ['Merged', 'Bands', 'Blobs'],
      tip: 'Merged: no mask at all — every element covers the whole screen and they stack on top of each other. Bands / Blobs: the screen is divided between the elements, so each one only draws inside its own zone, like a layer mask.',
      disabled: () => enabledCount() < 2,
      get: () => (comp === 'merged' ? 0 : comp === 'bands' ? 1 : 2),
      set: (v: number) => { comp = v === 0 ? 'merged' : v === 1 ? 'bands' : 'blobs'; maskDirty = true; } },
    { label: 'Arrangement', type: 'buttons', options: [...ARRANGEMENTS],
      tip: 'Chaotic scatters the zones over the whole surface. Left/Right and Up/Down give each element its own side, in order.',
      disabled: () => enabledCount() < 2 || comp === 'merged',
      get: () => ARRANGEMENT_VALUES.indexOf(arrangement),
      set: (v: number) => { arrangement = ARRANGEMENT_VALUES[v] ?? 'chaotic'; maskDirty = true; } },
    { label: 'Strictness', type: 'range', min: 0, max: 1, step: 0.01, default: 0.65,
      tip: 'Only for Left/Right and Up/Down: how unambiguous the split is. 0 lets sides blend and overlap. 1 gives a clean, obvious split.',
      disabled: () => enabledCount() < 2 || comp === 'merged' || arrangement === 'chaotic',
      get: () => strictness, set: (v: number) => { strictness = v; maskDirty = true; } },
    { label: 'Zones', type: 'range', min: 2, max: 6, step: 1, default: 3,
      tip: 'Blobs: how many clusters each element gets — more clusters, more scattered. Bands: only affects Chaotic.',
      disabled: () => enabledCount() < 2 || comp === 'merged'
        || (comp === 'bands' && arrangement !== 'chaotic'),
      get: () => zones, set: (v: number) => { zones = Math.round(v); maskDirty = true; } },
    { label: 'Interlock', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35,
      tip: 'How much neighbouring zones reach into each other at their edge — from a sharp seam to an almost seamless blend.',
      disabled: () => enabledCount() < 2 || comp === 'merged',
      get: () => lock, set: (v: number) => { lock = v; maskDirty = true; } },
    { label: 'Mask Edge', type: 'range', min: 0, max: 1, step: 0.01, default: 0.25,
      tip: 'How hard the boundary between two elements is. 0 is a crisp cut, 1 fades one element into the next over a wide band.',
      disabled: () => enabledCount() < 2 || comp === 'merged',
      get: () => maskEdge, set: (v: number) => { maskEdge = v; } },

    // ── Colour ────────────────────────────────────────────────────────────────
    { label: 'Colour', type: 'separator' },
    { label: 'Recolour', type: 'range', min: 0, max: 1, step: 0.01, default: 1,
      tip: 'How far the elements are re-coloured from the palette below. 1 (the default) puts every element on the shared film palette; turn it down to bring back each element’s own original colours.',
      get: () => recolour, set: (v: number) => { recolour = v; } },
    { label: 'Palette', type: 'range', min: 0, max: 1, step: 0.01, default: 0,
      tip: 'Left: Film — the Lustspiel phase colours, the default here. Right: Default — the app’s global colour palette above, changeable live. In between: a blend of both. Only has an effect while Recolour is above 0.',
      disabled: () => recolour <= 0.001,
      get: () => paletteBlend, set: (v: number) => { paletteBlend = v; } },
    { label: 'Colour Blend', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5,
      tip: 'Hard (0): brightness falls into stepped palette bands, like a posterised gradient map. Soft (1): a smooth ramp across the palette. Only has an effect while Recolour is above 0.',
      disabled: () => recolour <= 0.001,
      get: () => colourBlend, set: (v: number) => { colourBlend = v; } },

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
      // One quad per SOURCE (see targets[] above), not per layer.
      for (let l = 0; l < SOURCES.length; l++) {
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uTex: { value: null },
            uMask: { value: null },
            uZone: { value: null },
            uSlotSel: { value: new THREE.Vector4(1, 0, 0, 0) },
            uZoneOn: { value: 0 },
            uEdge: { value: 0.25 },
            uGain: { value: 1 },
            uPal: { value: palColors },
            uRecolour: { value: 0 },
            uColBlend: { value: 0.5 },
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
        mesh.visible = false;
        quadMats[l] = mat; quadMeshes[l] = mesh;
        ctx.scene.add(mesh);
      }

      for (let i = 0; i < SOURCES.length; i++) if (assign[i] >= 0) ensureSource(i);
    },

    update(dt: number, elapsed: number) {
      if (!renderer) return;

      // Advance each layer's clock EXACTLY once. Doing this inside the per-source
      // loop below would double the Warp speed on any layer holding two elements
      // and freeze layers that hold none.
      let maxSpeed = 0;
      for (let l = 0; l < layerCount; l++) {
        layerTime[l] += dt * speed[l];
        if (speed[l] > maxSpeed) maxSpeed = speed[l];
      }
      compTime += dt * maxSpeed;

      updatePalette();

      if (maskDirty) rebuildZoneMask();
      else if (masked() && zoneNeedsTimer() && elapsed - lastMaskBuild > 0.1) {
        lastMaskBuild = elapsed;
        rebuildZoneMask();
      }

      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;

      // The composite quads must not appear in their own source renders.
      for (let i = 0; i < SOURCES.length; i++) if (quadMeshes[i]) quadMeshes[i]!.visible = false;

      // ── render each element into its own target ──
      for (let i = 0; i < SOURCES.length; i++) {
        const l = assign[i];
        if (l < 0 || !started[i] || !scenes[i] || !cams[i]) continue;
        const rt = ensureTarget(i);
        renderer.setRenderTarget(rt);
        renderer.autoClear = true;
        renderer.clear(true, true, true);
        SOURCES[i].pattern.update(dt * speed[l], elapsed);
        renderer.render(scenes[i]!, cams[i]!);
      }

      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;

      // ── hand the elements to the app's own render pass ──
      const useMask = masked();
      for (let i = 0; i < SOURCES.length; i++) {
        const mesh = quadMeshes[i], mat = quadMats[i], rt = targets[i];
        const l = assign[i];
        if (!mesh || !mat) continue;
        const on = l >= 0 && !!rt;
        mesh.visible = on;
        if (!on) continue;
        updateMask(l);
        const slot = slotOf(i);
        mat.uniforms.uTex.value = rt!.texture;
        mat.uniforms.uMask.value = maskTex[l];
        mat.uniforms.uZone.value = zoneTex;
        (mat.uniforms.uSlotSel.value as THREE.Vector4).set(
          slot === 0 ? 1 : 0, slot === 1 ? 1 : 0, slot === 2 ? 1 : 0, slot === 3 ? 1 : 0);
        mat.uniforms.uZoneOn.value = useMask && zoneTex ? 1 : 0;
        mat.uniforms.uEdge.value = maskEdge;
        mat.uniforms.uGain.value = gain[i];
        mat.uniforms.uRecolour.value = recolour;
        mat.uniforms.uColBlend.value = colourBlend;
        (mat.uniforms.uTexel.value as THREE.Vector2).set(1 / rt!.width, 1 / rt!.height);
        mat.uniforms.uAtmo.value = atmo[l];
        mat.uniforms.uWarp.value = warp[l];
        mat.uniforms.uTime.value = layerTime[l];
        // Cosmetic only: with AdditiveBlending and depth off, clamped addition is
        // commutative, so draw order genuinely does not change the image. Depth
        // reads purely from the per-layer Atmosphere darkening.
        mesh.renderOrder = MAX_LAYERS - l;
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
      for (let i = 0; i < SOURCES.length; i++) if (targets[i]) ensureTarget(i);
      maskDirty = true;   // logical height changed -> mask grid aspect changed
    },

    dispose() {
      for (let i = 0; i < SOURCES.length; i++) stopSource(i);
      for (let i = 0; i < SOURCES.length; i++) { targets[i]?.dispose(); targets[i] = null; }
      for (let l = 0; l < MAX_LAYERS; l++) {
        maskTex[l]?.dispose(); maskTex[l] = null; maskData[l] = null;
      }
      zoneTex?.dispose(); zoneTex = null; zoneData = null;
      quadGeo?.dispose();
      for (let i = 0; i < SOURCES.length; i++) { quadMats[i]?.dispose(); quadMats[i] = null; quadMeshes[i] = null; }
      quadGeo = null;
      renderer = null;
    },
  };
}
