import type { Pattern } from "./types";
import { lines3d } from "./lines3d";
import { particles } from "./particles";
import { tunnel } from "./tunnel";
import { tunnelEdge } from "./tunnelEdge";
import { tunnelSmooth } from "./tunnelSmooth";
import { shaderGradient } from "./shaderGradient";
import { parallelLinesStraight } from "./parallelLinesStraight";
import { parallelLinesWave } from "./parallelLinesWave";
import { hyperMix } from "./hyperMix";
import { dotRain } from "./dotRain";
import { flowLines } from "./flowLines";
import { pearlFlow } from "./pearlFlow";
import { curlOrbs } from "./curlOrbs";
import { flowDots } from "./flowDots";
import { baroqueSwirls } from "./baroqueSwirls";
import { lightTrail } from "./light-trail";
import { lightPaint } from "./light-paint";
import { warpedSurfaces } from "./warpedSurfaces";
import { wavySphere } from "./wavySphere";
import { plasmaSphere } from "./plasmaSphere";
import { crystalGem } from "./crystalGem";
import { gosperFeedback } from "./gosperFeedback";
import { asciiSwirls } from "./asciiSwirls";
import { wrapWithPersist } from "../persist";
import { addMotionCamera } from "../motionCameraWrapper";

// Patterns that must NOT get the generic motion camera wrapper:
// - lightTrail / lightPaint  (camera-based themselves)
// - gosperFeedback / asciiSwirls  (manage their own internal scene + renderer ref)
const NO_MOTION_CAMERA = new Set(['lightTrail', 'lightPaint', 'gosperFeedback', 'asciiSwirls']);

const rawPatterns: Pattern[] = [
  particles,
  parallelLinesStraight,
  parallelLinesWave,
  dotRain,
  pearlFlow,
  flowDots,
  flowLines,
  curlOrbs,
  baroqueSwirls,
  shaderGradient,
  hyperMix,
  tunnel,
  tunnelEdge,
  tunnelSmooth,
  lines3d,
  warpedSurfaces,
  wavySphere,
  plasmaSphere,
  crystalGem,
  gosperFeedback,
  asciiSwirls,
  lightTrail,
  lightPaint,
];

export const patterns: Pattern[] = rawPatterns
  .map((p) => NO_MOTION_CAMERA.has(p.id) ? p : addMotionCamera(p))
  .map(wrapWithPersist);
