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
import { lightPaint, lightTrail, lightPaintBlack, lightFly, lightVortex, lightKaleido, lightGlitch } from "./light-paint";
import { warpedSurfaces } from "./warpedSurfaces";
import { wavySphere } from "./wavySphere";
import { crystalGem } from "./crystalGem";
import { asciiSwirls } from "./asciiSwirls";
import { particlesPalette } from "./particlesPalette";
import { tunnelEdgePalette } from "./tunnelEdgePalette";
import { heatMap } from "./heatMap";
import { particlesHeat } from "./particlesHeat";
import { hyperMixHeat } from "./hyperMixHeat";
import { typography3d } from "./typography3d";
import { makeImagePattern } from "./imagePattern";
import { wrapWithPersist } from "../persist";
import { wrapWithBroadcast } from "../remote/broadcastWrap";
import { addMotionCamera } from "../motionCameraWrapper";
import { addAudioReactivity } from "../audioReactivityWrapper";

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

// Patterns that must NOT get the generic motion camera wrapper:
// - light* family  (camera-based themselves)
// - asciiSwirls  (manages its own internal scene + renderer ref)
const LIGHT_IDS = ['lightPaint', 'lightTrail', 'lightPaintBlack', 'lightFly', 'lightVortex', 'lightKaleido', 'lightGlitch'];
const NO_MOTION_CAMERA = new Set([...LIGHT_IDS, 'asciiSwirls']);

// Light patterns get audio reactivity (Brightness via mic) but not motion camera
const NO_AUDIO = new Set(['typography3d']);

const rawPatterns: Pattern[] = [
  hyperMixHeat,
  particlesHeat,
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
  // ── Experimental ──────────────────────────────────────────────────────────
  particlesPalette,
  tunnelEdgePalette,
];

export const patterns: Pattern[] = rawPatterns
  .map(p => NO_MOTION_CAMERA.has(p.id) ? p : addMotionCamera(p))
  .map(p => NO_AUDIO.has(p.id) ? p : addAudioReactivity(p))
  .map(wrapWithPersist)
  .map(wrapWithBroadcast);
