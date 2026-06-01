// Particle Field — Combined detector.
// Requires BOTH a spatial patchiness spike AND a baseline excess before
// triggering. Most conservative — fewest false positives from the projected
// pattern's own motion.

import { CombinedDetector } from "../motionDetector";
import { makeParticleFieldPattern } from "../particleFieldBase";

export const particleFieldCombined = makeParticleFieldPattern(
  "particleFieldCombined",
  "Particle Field · Combined",
  () => new CombinedDetector(),
);
