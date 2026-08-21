import type { Pattern } from "./types";
import { lines3d } from "./lines3d";
import { particleLines } from "./particleLines";
import { tunnel } from "./tunnel";
import { tunnelEdge } from "./tunnelEdge";
import { shaderGradient } from "./shaderGradient";
import { parallelLinesStraight } from "./parallelLinesStraight";
import { parallelLinesWave } from "./parallelLinesWave";
import { flowLines } from "./flowLines";
import { curlOrbsBody } from "./curlOrbsBody";
import { baroqueSwirlsBody } from "./baroqueSwirlsBody";
import { lightPaint, lightTrail, lightPaintBlack, lightFly, lightVortex, lightMirror, lightKaleido, lightGlitch } from "./light-paint";
import { warpedSurfaces } from "./warpedSurfaces";
import { wavySphere } from "./wavySphere";
import { crystalGem } from "./crystalGem";
import { asciiSwirls } from "./asciiSwirls";
import { particlesPalette } from "./particlesPalette";
import { tunnelEdgePalette } from "./tunnelEdgePalette";
import { heatMap } from "./heatMap";
import { particlesHeat } from "./particlesHeat";
import { gravityLines } from "./gravityLines";
import { volcano } from "./volcano";
import { hyperMixHeat } from "./hyperMixHeat";
import { typography3d } from "./typography3d";
import { makeImagePattern } from "./imagePattern";
import { makeLustspielPattern } from "./lustspielPattern";
import { makeLustspielParticle } from "./lustspielParticle";
import { makeLustspielCombined } from "./lustspielCombined";
import { wrapWithPersist } from "../persist";
import { wrapWithBroadcast } from "../remote/broadcastWrap";
import { addMotionCamera } from "../motionCameraWrapper";
import { addAudioReactivity } from "../audioReactivityWrapper";
import { interactionState, type PatternInteractionSettings } from "../interactionState.svelte";

// Lustspiel 1/2/3 — one entry per phase; elements are toggles inside the pattern.
// Defaults lean toward the character of one of the original inspiration images
// (public/images/dot-waves, two-feather, baroque-vines), and each adds a Speed
// control (0 holds the image still, 1 lets it slowly drift — only field()/
// intensity()/zoneU() ever see that time value, hash() never does, so drift
// never changes which shapes exist, only their form — see engine.ts) plus an
// Animate toggle: off pins state.time at 0 AND sets state.animated = false,
// reproducing the exact static look the former separate Lustspiel A/B/C
// patterns had (state.animated gates a small non-zero static offset in
// bendOf()/elPoints/elMesh that persists even at Speed 0 — see
// [[project-lustspiel-patterns]]). A/B/C were removed once this made them
// redundant.
// Phase matches the number (1→A, 2→B, 3→C) so the colour character tracks
// the old A/B/C naming: 1 mostly white/blue, 2 and 3 progressively more colourful.
const lsp1 = makeLustspielPattern('lsp-1', 'Lustspiel 1', 'A', {
  // dot-waves / flowing-dots: an S-band of lines with a halftone field of dots.
  animated: true, speedDefault: 0.15,
  defaults: { elems: [1, 2], pointStyle: 'wave', comp: 'blobs', arrangement: 'chaotic', organic: 0.35, warp: 0.8, dens: 1.4, colorSoftness: 0.4 },
});
const lsp2 = makeLustspielPattern('lsp-2', 'Lustspiel 2', 'B', {
  // two-feather: dots and strands split left/right of a wandering centre line.
  animated: true, speedDefault: 0.15,
  defaults: { elems: [1, 2], comp: 'blobs', arrangement: 'leftRight', strictness: 0.8, organic: 0.25, warp: 1.2, dens: 1.0, colorSoftness: 0.2 },
});
const lsp3 = makeLustspielPattern('lsp-3', 'Lustspiel 3', 'C', {
  // baroque-vines: winding, clustered growth in the deep violet phase palette.
  // Warp/Organic kept close to 1/2's range (not the 1.6/0.75 tried earlier) —
  // both feed the drift amplitude, so a big gap there made Speed feel like a
  // different, faster control on this pattern for the same slider position.
  animated: true, speedDefault: 0.15,
  defaults: { elems: [2, 3], comp: 'blobs', arrangement: 'chaotic', organic: 0.5, warp: 1.25, dens: 1.0, zones: 4, colorSoftness: 0.3 },
});

// Lustspiel Organic — a different angle from 1/2/3: instead of a clean
// composition tuned toward one inspiration image, all four elements run at
// once and an "Atmosphere" layer (engine.ts's paintAtmosphere()) unevenly
// dissolves patches of the frame into a soft wash of colour or lets them
// sink toward black — deliberately uneven, "dirty", alive, never the same
// twice at a new Seed. Softness stays 0 by default: a uniform blur on top
// would fight the point of Atmosphere being uneven in the first place.
const lspOrganic = makeLustspielPattern('lsp-organic', 'Lustspiel Organic', 'C', {
  animated: true, speedDefault: 0.12,
  atmosphere: true, atmosphereDefault: 0.65,
  defaults: {
    elems: [1, 2, 3, 4, 5], pointStyle: 'wave', comp: 'blobs', arrangement: 'chaotic',
    organic: 0.6, warp: 1.3, dens: 1.0, zones: 5, lock: 0.5, colorSoftness: 0.5,
  },
});

// Lustspiel Particle — same layered/atmosphere idea as Organic, but each element
// is one of the app's existing patterns hosted in its own scene and render
// target. See lustspielParticle.ts for why those four can be hosted unmodified.
const lspParticle = makeLustspielParticle('lsp-particle', 'Lustspiel Particle');

// Lustspiel Alpha/Beta/Gamma — combine 1/2/3's Canvas2D vocabulary (Points,
// Lines, Mesh, Rings, Gravity) AND Particle's four hosted WebGL elements
// (Particle Field, Gravity Lines, Hyper Mix, Parallel Lines) in one pattern,
// all nine sharing one ordered list and one zone partition. See
// lustspielCombined.ts for how the two families share a partition, and for
// the honest limitations (Heat/Push is hosted-only, Recolour is hosted-only).
const lspAlpha = makeLustspielCombined('lsp-alpha', 'Lustspiel Alpha', 'A');
const lspBeta = makeLustspielCombined('lsp-beta', 'Lustspiel Beta', 'B');
const lspGamma = makeLustspielCombined('lsp-gamma', 'Lustspiel Gamma', 'C');

// Lustspiel is meant to be danced in, not reacted to by default — the shared Tier 1
// "Interactions" universals (Colour v2, Speed, Direction, Burst) default ON for every
// pattern in the app (see interactionState.svelte.ts). Seed the opposite for these
// six specific ids, once, at the earliest possible point (module load, before any
// control is ever read) — and only if nothing was saved for them yet, so a later,
// deliberate opt-in from the Options panel is never overwritten.
for (const id of ['lsp-1', 'lsp-2', 'lsp-3', 'lsp-organic', 'lsp-particle', 'lsp-alpha', 'lsp-beta', 'lsp-gamma']) {
  if (interactionState.patternSettings[id]) continue;
  const off: PatternInteractionSettings = {
    brightnessEnabled: false, brightnessGain: 1.0,
    colorsV2Enabled: false, colorsV2Gain: 1.0,
    speedEnabled: false, speedGain: 1.0,
    directionEnabled: false, directionXBlend: 0.5, directionYBlend: 0.0,
    burstEnabled: false, burstMagnitude: 0.5,
  };
  interactionState.patternSettings[id] = off;
}

// Static image patterns (one per artwork)
const _base = import.meta.env.BASE_URL;
const imgTealLines     = makeImagePattern('img-tealLines',     'Teal Lines',     `${_base}images/teal-lines.webp`);
const imgOrganicWeb    = makeImagePattern('img-organicWeb',    'Organic Web',    `${_base}images/organic-web.webp`);
const imgDotWaves      = makeImagePattern('img-dotWaves',      'Dot Waves',      `${_base}images/dot-waves.webp`);
const imgBaroqueVines  = makeImagePattern('img-baroqueVines',  'Baroque Vines',  `${_base}images/baroque-vines.webp`);
const imgThinVerticals = makeImagePattern('img-thinVerticals', 'Thin Verticals', `${_base}images/thin-verticals.webp`);
const imgTwoFeather    = makeImagePattern('img-twoFeather',    'Two Feather',    `${_base}images/two-feather.webp`);
const imgRootWave      = makeImagePattern('img-rootWave',      'Root Wave',      `${_base}images/root-wave.webp`);
const imgPurpleOrnate  = makeImagePattern('img-purpleOrnate',  'Purple Ornate',  `${_base}images/purple-ornate.webp`);
const imgFlowingDots   = makeImagePattern('img-flowingDots',   'Flowing Dots',   `${_base}images/flowing-dots.webp`);

// Patterns whose heat effect is a positional displacement, so the Push sensor can
// drive it instead: your body clears a path through them. Left out are the patterns
// that use heat for something Push has no meaning for — a camera tilt toward the
// person (Tunnel Edge, 3D Typography, 3D Lines, Crystal Gem, Wavy Sphere) or a bend
// of a flow angle rather than a position (Baroque Swirls, Flow Lines).
const PUSH_IDS = new Set([
  'particlesHeat', 'hyperMixHeat', 'gravityLines', 'volcano', 'particleLines',
  'parallelLinesStraight', 'parallelLinesWave', 'tunnel', 'shaderGradient',
  'warpedSurfaces', 'curlOrbsBody',
  'img-tealLines', 'img-organicWeb', 'img-dotWaves', 'img-baroqueVines',
  'img-thinVerticals', 'img-twoFeather', 'img-rootWave', 'img-purpleOrnate',
  'img-flowingDots',
  // Hosts Hyper Mix / Particle Field / Gravity Lines / Parallel Lines, all of
  // which are Push-capable — they read the push field in their own shaders.
  'lsp-particle', 'lsp-alpha', 'lsp-beta', 'lsp-gamma',
]);

// Patterns that must NOT get the generic motion camera wrapper:
// - light* family  (camera-based themselves)
// - asciiSwirls  (manages its own internal scene + renderer ref)
export const LIGHT_IDS = ['lightPaint', 'lightTrail', 'lightPaintBlack', 'lightFly', 'lightVortex', 'lightMirror', 'lightKaleido', 'lightGlitch'];
export const LUSTSPIEL_IDS = ['lsp-1', 'lsp-2', 'lsp-3', 'lsp-organic', 'lsp-particle', 'lsp-alpha', 'lsp-beta', 'lsp-gamma'];
const NO_MOTION_CAMERA = new Set([...LIGHT_IDS, 'asciiSwirls']);

const rawPatterns: Pattern[] = [
  hyperMixHeat,
  particlesHeat,
  gravityLines,
  volcano,
  heatMap,
  particleLines,
  parallelLinesStraight,
  parallelLinesWave,
  flowLines,
  curlOrbsBody,
  tunnel,
  tunnelEdge,
  baroqueSwirlsBody,
  shaderGradient,
  warpedSurfaces,
  lines3d,
  asciiSwirls,
  wavySphere,
  crystalGem,
  typography3d,
  lightPaint,
  lightTrail,
  lightPaintBlack,
  lightFly,
  lightVortex,
  lightMirror,
  lightKaleido,
  lightGlitch,
  imgTealLines,
  imgOrganicWeb,
  imgDotWaves,
  imgBaroqueVines,
  imgThinVerticals,
  imgTwoFeather,
  imgRootWave,
  imgPurpleOrnate,
  imgFlowingDots,
  lsp1,
  lsp2,
  lsp3,
  lspOrganic,
  lspParticle,
  lspAlpha,
  lspBeta,
  lspGamma,
  // ── Experimental ──────────────────────────────────────────────────────────
  particlesPalette,
  tunnelEdgePalette,
];

export const patterns: Pattern[] = rawPatterns
  .map(p => PUSH_IDS.has(p.id) ? { ...p, pushReactive: true } : p)
  .map(p => NO_MOTION_CAMERA.has(p.id) ? p : addMotionCamera(p))
  .map(addAudioReactivity)
  .map(wrapWithPersist)
  .map(wrapWithBroadcast);
