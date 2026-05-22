import type { Pattern } from "./types";
import { lines3d } from "./lines3d";
import { particles } from "./particles";
import { particlesBody } from "./particlesBody";
import { particleLines } from "./particleLines";
import { tunnel } from "./tunnel";
import { tunnelEdge } from "./tunnelEdge";
import { shaderGradient } from "./shaderGradient";
import { parallelLinesStraight } from "./parallelLinesStraight";
import { parallelLinesWave } from "./parallelLinesWave";
import { hyperMix } from "./hyperMix";
import { dotRain } from "./dotRain";
import { dotRainBody } from "./dotRainBody";
import { flowLines } from "./flowLines";
import { pearlFlow } from "./pearlFlow";
import { curlOrbs } from "./curlOrbs";
import { curlOrbsBody } from "./curlOrbsBody";
import { flowDots } from "./flowDots";
import { baroqueSwirls } from "./baroqueSwirls";
import { baroqueSwirlsBody } from "./baroqueSwirlsBody";
import { lightTrail } from "./light-trail";
import { lightPaint } from "./light-paint";
import { warpedSurfaces } from "./warpedSurfaces";
import { wavySphere } from "./wavySphere";
import { plasmaSphere } from "./plasmaSphere";
import { crystalGem } from "./crystalGem";
import { asciiSwirls } from "./asciiSwirls";
import { particlesPalette } from "./particlesPalette";
import { tunnelEdgePalette } from "./tunnelEdgePalette";
import { typography3d } from "./typography3d";
import { makeImagePattern } from "./imagePattern";
import { wrapWithPersist } from "../persist";
import { addMotionCamera } from "../motionCameraWrapper";
import { addAudioReactivity } from "../audioReactivityWrapper";

// Static image patterns (one per artwork)
const _base = import.meta.env.BASE_URL;
const imgTealLines     = makeImagePattern('img-tealLines',     'Teal Lines',     `${_base}images/teal-lines.webp`);
const imgOrganicWeb    = makeImagePattern('img-organicWeb',    'Organic Web',    `${_base}images/organic-web.webp`);
const imgDotWaves      = makeImagePattern('img-dotWaves',      'Dot Waves',      `${_base}images/dot-waves.webp`);
const imgBaroqueVines  = makeImagePattern('img-baroqueVines',  'Baroque Vines',  `${_base}images/baroque-vines.webp`);
const imgThinVerticals = makeImagePattern('img-thinVerticals', 'Thin Verticals', `${_base}images/thin-verticals.webp`);

// Patterns that must NOT get the generic motion camera wrapper:
// - lightTrail / lightPaint  (camera-based themselves)
// - asciiSwirls  (manages its own internal scene + renderer ref)
// - image patterns  (handle their own pose/audio directly)
const NO_MOTION_CAMERA = new Set(['lightTrail', 'lightPaint', 'asciiSwirls', 'typography3d',
  'img-tealLines', 'img-organicWeb', 'img-dotWaves', 'img-baroqueVines', 'img-thinVerticals']);

// Patterns that skip audio reactivity wrapping (camera-based patterns, image patterns handle audio directly)
const NO_AUDIO = new Set(['lightTrail', 'lightPaint', 'typography3d',
  'img-tealLines', 'img-organicWeb', 'img-dotWaves', 'img-baroqueVines', 'img-thinVerticals']);

const rawPatterns: Pattern[] = [
  particles,
  particlesBody,
  particleLines,
  parallelLinesStraight,
  parallelLinesWave,
  flowLines,
  curlOrbs,
  curlOrbsBody,
  tunnel,
  tunnelEdge,
  baroqueSwirls,
  baroqueSwirlsBody,
  shaderGradient,
  warpedSurfaces,
  hyperMix,
  lines3d,
  asciiSwirls,
  dotRain,
  dotRainBody,
  pearlFlow,
  flowDots,
  wavySphere,
  plasmaSphere,
  crystalGem,
  particlesPalette,
  tunnelEdgePalette,
  typography3d,
  lightTrail,
  lightPaint,
  imgTealLines,
  imgOrganicWeb,
  imgDotWaves,
  imgBaroqueVines,
  imgThinVerticals,
];

export const patterns: Pattern[] = rawPatterns
  .map(p => NO_MOTION_CAMERA.has(p.id) ? p : addMotionCamera(p))
  .map(p => NO_AUDIO.has(p.id) ? p : addAudioReactivity(p))
  .map(wrapWithPersist);
