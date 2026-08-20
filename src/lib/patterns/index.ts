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
import { wrapWithPersist } from "../persist";
import { wrapWithBroadcast } from "../remote/broadcastWrap";
import { addMotionCamera } from "../motionCameraWrapper";
import { addAudioReactivity } from "../audioReactivityWrapper";
import { interactionState, type PatternInteractionSettings } from "../interactionState.svelte";

// Lustspiel — one entry per phase; elements are toggles inside the pattern
const lspA = makeLustspielPattern('lsp-a', 'Lustspiel A', 'A');
const lspB = makeLustspielPattern('lsp-b', 'Lustspiel B', 'B');
const lspC = makeLustspielPattern('lsp-c', 'Lustspiel C', 'C');

// Lustspiel is meant to be danced in, not reacted to by default — the shared Tier 1
// "Interactions" universals (Colour v2, Speed, Direction, Burst) default ON for every
// pattern in the app (see interactionState.svelte.ts). Seed the opposite for these
// three specific ids, once, at the earliest possible point (module load, before any
// control is ever read) — and only if nothing was saved for them yet, so a later,
// deliberate opt-in from the Options panel is never overwritten.
for (const id of ['lsp-a', 'lsp-b', 'lsp-c']) {
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
]);

// Patterns that must NOT get the generic motion camera wrapper:
// - light* family  (camera-based themselves)
// - asciiSwirls  (manages its own internal scene + renderer ref)
export const LIGHT_IDS = ['lightPaint', 'lightTrail', 'lightPaintBlack', 'lightFly', 'lightVortex', 'lightMirror', 'lightKaleido', 'lightGlitch'];
export const LUSTSPIEL_IDS = ['lsp-a', 'lsp-b', 'lsp-c'];
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
  lspA,
  lspB,
  lspC,
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
