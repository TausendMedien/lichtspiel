// Particle Field — Spatial Patchiness detector.
// Separates person motion from pattern motion by measuring how "localised"
// (patchy) the frame-to-frame motion is. Uniform motion = pattern; clustered
// blobs = people.

import { SpatialPatchinessDetector } from "../motionDetector";
import { makeParticleFieldPattern } from "../particleFieldBase";

export const particleFieldSpatial = makeParticleFieldPattern(
  "particleFieldSpatial",
  "Particle Field · Spatial",
  () => new SpatialPatchinessDetector(),
);
